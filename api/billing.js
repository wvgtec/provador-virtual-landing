// api/billing.js
// Faturamento do cliente: resumo, faturas, checkout Stripe, portal Stripe.
// Se STRIPE_SECRET_KEY não estiver definido, retorna dados mock / Redis only.

import { Redis } from '@upstash/redis';
import { timingSafeEqual } from 'crypto';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PLAN_LIMITS = {
  starter:    { limit: 100,      price: 9,   overage: 0.15 },
  pro:        { limit: 500,      price: 29,  overage: 0.08 },
  growth:     { limit: 1000,     price: 49,  overage: 0.04 },
  scale:      { limit: 5000,     price: 149, overage: 0.02 },
  enterprise: { limit: Infinity, price: 499, overage: 0    },
};

// Stripe é opcional — só carrega se a chave existir
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    const { default: Stripe } = await import('stripe');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
  } catch (e) {
    console.warn('[billing] Stripe não disponível:', e.message);
  }
}

function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

async function authenticate(clientKey, secret) {
  if (!clientKey || !isValidClientKey(clientKey)) return null;
  if (!secret || typeof secret !== 'string' || secret.length < 10) return null;
  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return null;
  const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!client.active) return null;
  if (!safeCompare(secret, client.secret || '')) return null;
  return client;
}

function calcBilling(client) {
  const plan    = PLAN_LIMITS[client.plan] ?? PLAN_LIMITS.starter;
  const usage   = Number(client.usageCount) || 0;
  const excess  = Math.max(0, usage - plan.limit);
  const overageAmt = +(excess * plan.overage).toFixed(2);
  const total   = +(plan.price + overageAmt).toFixed(2);
  return { planPrice: plan.price, limit: plan.limit, overage: plan.overage, usage, excess, overageAmt, total };
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

  const { action, clientKey, secret, ...params } = req.body || {};

  const client = await authenticate(clientKey, secret);
  if (!client) return res.status(401).json({ error: 'Credenciais inválidas.' });

  const stripeEnabled = !!stripe;

  try {
    // SUMMARY — resumo de billing do mês atual
    if (action === 'summary') {
      const billing = calcBilling(client);
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
      const billing = calcBilling(client);
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

    // CHECKOUT — cria sessão Stripe para pagar fatura ou fazer upgrade
    if (action === 'checkout') {
      if (!stripe) {
        return res.status(503).json({ error: 'Stripe não configurado. Entre em contato com o suporte.' });
      }
      const { invoiceId, returnUrl } = params;
      const origin = returnUrl || process.env.CLIENT_PANEL_URL || 'https://wvgtec.github.io/provador-virtual-landing/painel-cliente.html';

      // Se for pagar uma fatura específica
      if (invoiceId && !invoiceId.startsWith('mock_')) {
        const inv = await stripe.invoices.retrieve(invoiceId);
        if (inv.hosted_invoice_url) {
          return res.json({ ok: true, url: inv.hosted_invoice_url });
        }
      }

      // Checkout genérico (upgrade / renovação)
      let customerId = client.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: client.email, name: client.name, metadata: { clientKey } });
        customerId = customer.id;
        await redis.set(`client:${clientKey}`, JSON.stringify({ ...client, stripeCustomerId: customerId }));
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `Mirage - Plano ${client.plan || 'starter'}` },
            unit_amount: Math.round(calcBilling(client).total * 100),
          },
          quantity: 1,
        }],
        success_url: `${origin}?payment=success`,
        cancel_url:  `${origin}?payment=cancel`,
      });

      return res.json({ ok: true, url: session.url });
    }

    // PORTAL — cria sessão do Customer Portal do Stripe
    if (action === 'portal') {
      if (!stripe || !client.stripeCustomerId) {
        return res.status(503).json({ error: 'Portal Stripe não disponível.' });
      }
      const returnUrl = params.returnUrl || process.env.CLIENT_PANEL_URL || 'https://wvgtec.github.io/provador-virtual-landing/painel-cliente.html';
      const session = await stripe.billingPortal.sessions.create({
        customer: client.stripeCustomerId,
        return_url: returnUrl,
      });
      return res.json({ ok: true, url: session.url });
    }

    return res.status(400).json({ error: 'Ação inválida.' });

  } catch (err) {
    console.error('[billing] Erro:', err);
    return res.status(500).json({ error: 'Erro interno de billing.' });
  }
}
