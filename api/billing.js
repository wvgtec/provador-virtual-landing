// api/billing.js
// Faturamento do cliente: resumo, faturas, checkout Stripe, portal Stripe.
// Se STRIPE_SECRET_KEY não estiver definido, retorna dados mock / Redis only.

import { Redis } from '@upstash/redis';
import { timingSafeEqual, scryptSync } from 'crypto';
import Stripe from 'stripe';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PLAN_LIMITS = {
  starter:    { limit: 100,      price: 49,   overage: 0.75 },
  pro:        { limit: 500,      price: 149,  overage: 0.40 },
  growth:     { limit: 1000,     price: 249,  overage: 0.20 },
  scale:      { limit: 5000,     price: 749,  overage: 0.10 },
  enterprise: { limit: Infinity, price: 2499, overage: 0    },
};

// Stripe — ativo somente se a chave estiver configurada
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' })
  : null;

function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

function verifyPassword(input, stored) {
  if (!stored || !input) return false;
  // Formato scrypt: "salt:hash"
  if (stored.includes(':') && stored.length > 60) {
    try {
      const [salt, hash] = stored.split(':');
      const inputHash = scryptSync(String(input), salt, 64).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(inputHash, 'hex'));
    } catch { return false; }
  }
  // Legado: secret base64url
  return safeCompare(input, stored);
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

async function authenticate(clientKey, password) {
  if (!clientKey || !isValidClientKey(clientKey)) return null;
  if (!password || typeof password !== 'string') return null;
  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return null;
  const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!client.active) return null;
  const stored = client.passwordHash || client.secret || '';
  if (!verifyPassword(password, stored)) return null;
  return client;
}

const PLAN_NAMES = { starter:'Starter', pro:'Pro', growth:'Growth', scale:'Scale', enterprise:'Enterprise' };

async function getPlanLimits(planId) {
  // Tenta buscar plano customizado do Redis
  const raw = await redis.get(`plan:${planId}`).catch(() => null);
  if (raw) {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { name: p.name || planId, limit: p.tryons === 0 ? Infinity : (Number(p.tryons) || 100), price: Number(p.price) || 0, overage: Number(p.overage) || 0 };
  }
  // Fallback para planos hardcoded
  const fp = PLAN_LIMITS[planId] ?? PLAN_LIMITS.starter;
  return { name: PLAN_NAMES[planId] || planId, ...fp };
}

async function calcBilling(client) {
  const plan    = await getPlanLimits(client.plan || 'starter');
  const usage   = Number(client.usageCount) || 0;
  const excess  = Math.max(0, usage - plan.limit);
  const overageAmt = +(excess * plan.overage).toFixed(2);
  const total   = +(plan.price + overageAmt).toFixed(2);
  return { planName: plan.name, planPrice: plan.price, limit: plan.limit, overage: plan.overage, usage, excess, overageAmt, total };
}

// Gera data da próxima cobrança (5 de cada mês)
function nextBillingDate() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + (now.getDate() >= 5 ? 1 : 0), 5);
  return next.toISOString().split('T')[0];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, clientKey, password, ...params } = req.body || {};

  const client = await authenticate(clientKey, password);
  if (!client) return res.status(401).json({ error: 'Credenciais inválidas.' });

  const stripeEnabled = !!stripe;

  try {
    // SUMMARY — resumo de billing do mês atual
    if (action === 'summary') {
      const billing = await calcBilling(client);
      const nextDate = nextBillingDate();

      let paymentMethod = null;
      let subscriptionStatus = 'active';

      if (stripe && client.stripeCustomerId) {
        try {
          const methods = await stripe.paymentMethods.list({
            customer: client.stripeCustomerId,
            type: 'card',
            limit: 1,
          });
          if (methods.data.length) {
            const card = methods.data[0].card;
            paymentMethod = { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year };
          }
          const subs = await stripe.subscriptions.list({ customer: client.stripeCustomerId, limit: 1 });
          if (subs.data.length) subscriptionStatus = subs.data[0].status;
        } catch (e) {
          console.warn('[billing] Stripe summary error:', e.message);
        }
      }

      return res.json({
        ok: true,
        stripeEnabled,
        plan: client.plan || 'starter',
        ...billing,
        nextDate,
        paymentMethod,
        subscriptionStatus,
      });
    }

    // INVOICES — lista faturas
    if (action === 'invoices') {
      if (stripe && client.stripeCustomerId) {
        const invoices = await stripe.invoices.list({
          customer: client.stripeCustomerId,
          limit: 24,
        });
        const items = invoices.data.map(inv => ({
          id:        inv.id,
          number:    inv.number,
          date:      new Date(inv.created * 1000).toISOString().split('T')[0],
          amount:    +(inv.amount_due / 100).toFixed(2),
          amountPaid: +(inv.amount_paid / 100).toFixed(2),
          status:    inv.status,
          pdfUrl:    inv.invoice_pdf,
          hostedUrl: inv.hosted_invoice_url,
          periodStart: inv.period_start ? new Date(inv.period_start * 1000).toISOString().split('T')[0] : null,
          periodEnd:   inv.period_end   ? new Date(inv.period_end   * 1000).toISOString().split('T')[0] : null,
          lines: inv.lines?.data?.map(l => ({
            description: l.description,
            amount: +(l.amount / 100).toFixed(2),
          })) || [],
        }));
        return res.json({ ok: true, invoices: items });
      }

      // Sem Stripe: gera histórico mock baseado em Redis
      const billing = await calcBilling(client);
      const mock = [];
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 5);
        mock.push({
          id:      `mock_${i}`,
          number:  null,
          date:    d.toISOString().split('T')[0],
          amount:  billing.total,
          amountPaid: i === 0 ? 0 : billing.total,
          status:  i === 0 ? 'pending' : 'paid',
          pdfUrl:  null,
          hostedUrl: null,
          periodStart: new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().split('T')[0],
          periodEnd:   new Date(d.getFullYear(), d.getMonth(), 0).toISOString().split('T')[0],
          lines: [
            { description: `Plano ${client.plan || 'starter'}`, amount: billing.planPrice },
            ...(billing.overageAmt > 0 ? [{ description: `${billing.excess} gerações excedentes × $${billing.overage}`, amount: billing.overageAmt }] : []),
          ],
        });
      }
      return res.json({ ok: true, invoices: mock, isMock: true });
    }

    // Helper: garante customer Stripe e mantém o índice stripe:customer: → clientKey
    async function ensureCustomer() {
      if (client.stripeCustomerId) {
        // Garante que o índice existe (migração silenciosa)
        await redis.set(`stripe:customer:${client.stripeCustomerId}`, clientKey);
        return client.stripeCustomerId;
      }
      const customer = await stripe.customers.create({
        email: client.email, name: client.name, metadata: { clientKey },
      });
      client.stripeCustomerId = customer.id;
      await Promise.all([
        redis.set(`client:${clientKey}`, JSON.stringify(client)),
        redis.set(`stripe:customer:${customer.id}`, clientKey),
      ]);
      return customer.id;
    }

    const pubKey = process.env.STRIPE_PUBLISHABLE_KEY || '';

    // SETUP_INTENT — salvar/trocar cartão inline
    if (action === 'setup_intent') {
      if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });
      const customerId = await ensureCustomer();
      const si = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
      });
      return res.json({ ok: true, clientSecret: si.client_secret, publishableKey: pubKey });
    }

    // PAY_INVOICE — pagar fatura inline
    if (action === 'pay_invoice') {
      if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });
      const { invoiceId } = params;
      const customerId = await ensureCustomer();

      // Fatura real do Stripe
      if (invoiceId && !invoiceId.startsWith('mock_')) {
        const inv = await stripe.invoices.retrieve(invoiceId);
        if (inv.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(inv.payment_intent);
          return res.json({ ok: true, clientSecret: pi.client_secret, publishableKey: pubKey, amount: inv.amount_due / 100 });
        }
      }

      // Sem fatura real: cria PaymentIntent avulso com boleto + cartão
      const billing = await calcBilling(client);
      const amountCents = Math.round(billing.total * 100) || 100;
      const pi = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: 'brl',
        customer: customerId,
        payment_method_types: ['card', 'boleto'],
        metadata: { clientKey, plan: client.plan || 'starter' },
      });
      return res.json({ ok: true, clientSecret: pi.client_secret, publishableKey: pubKey, amount: billing.total });
    }

    // PAYMENT_LINK — cria link de pagamento Stripe (boleto / pix / cartão)
    if (action === 'payment_link') {
      if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });
      const { invoiceId } = params;

      // Se tem fatura real com hosted URL, retorna direto
      if (invoiceId && !invoiceId.startsWith('mock_')) {
        try {
          const inv = await stripe.invoices.retrieve(invoiceId);
          if (inv.hosted_invoice_url) {
            return res.json({ ok: true, url: inv.hosted_invoice_url });
          }
        } catch (e) { /* continua */ }
      }

      // Cria payment link avulso
      const customerId2 = await ensureCustomer();
      const billing = await calcBilling(client);
      const amountCents = Math.round(billing.total * 100) || 100;
      const product = await stripe.products.create({
        name: `Mirage Provador Virtual — ${client.plan || 'starter'}`,
      });
      const price = await stripe.prices.create({
        unit_amount: amountCents,
        currency:    'brl',
        product:     product.id,
      });
      const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        customer_creation: 'always',
        metadata: { clientKey },
      });
      return res.json({ ok: true, url: link.url });
    }

    return res.status(400).json({ error: 'Ação inválida.' });

  } catch (err) {
    console.error('[billing] Erro:', err);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}