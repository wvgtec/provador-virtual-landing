// api/stripe-webhook.js
// Recebe eventos do Stripe e sincroniza plano, status e uso no Redis.
// Chamado diretamente pelo Stripe — não passa pelo QStash.
// IMPORTANTE: lê o body bruto do stream (sem body parser) para verificar a assinatura.

import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Planos hardcoded como fallback — limites em try-ons por ciclo
const PLAN_LIMITS = {
  starter:    100,
  pro:        500,
  growth:     1000,
  scale:      5000,
  enterprise: Infinity,
};

// ─── Log estruturado ─────────────────────────────────────────────────────────

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

// ─── Mapeamento priceId → plano ────────────────────────────────────────────
// Configure as variáveis de ambiente no Vercel com os price IDs do Stripe.

function mapPriceToPlan(priceId) {
  const map = {};
  if (process.env.STRIPE_PRICE_STARTER)    map[process.env.STRIPE_PRICE_STARTER]    = 'starter';
  if (process.env.STRIPE_PRICE_PRO)        map[process.env.STRIPE_PRICE_PRO]        = 'pro';
  if (process.env.STRIPE_PRICE_GROWTH)     map[process.env.STRIPE_PRICE_GROWTH]     = 'growth';
  if (process.env.STRIPE_PRICE_SCALE)      map[process.env.STRIPE_PRICE_SCALE]      = 'scale';
  if (process.env.STRIPE_PRICE_ENTERPRISE) map[process.env.STRIPE_PRICE_ENTERPRISE] = 'enterprise';
  return map[priceId] || null;
}

// ─── Leitura do body bruto (necessário para verificar assinatura Stripe) ────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Helpers Redis ────────────────────────────────────────────────────────────

async function getClientKey(stripe, customerId) {
  // Tenta o índice rápido primeiro
  const found = await redis.get(`stripe:customer:${customerId}`);
  if (found) return String(found);

  // Fallback: busca nos metadados do customer no Stripe
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted && customer.metadata?.clientKey) {
      // Reconstrói o índice silenciosamente
      await redis.set(`stripe:customer:${customerId}`, customer.metadata.clientKey);
      return customer.metadata.clientKey;
    }
  } catch (e) {
    log('webhook_customer_lookup_error', { customerId, error: e.message });
  }
  return null;
}

async function getClient(clientKey) {
  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveClient(clientKey, client) {
  await redis.set(`client:${clientKey}`, JSON.stringify(client));
}

// ─── Handlers de evento ────────────────────────────────────────────────────

// invoice.paid — pagamento confirmado: ativa conta e zera contador mensal
async function handleInvoicePaid(stripe, invoice) {
  const clientKey = await getClientKey(stripe, invoice.customer);
  if (!clientKey) {
    log('webhook_invoice_paid_no_client', { customerId: invoice.customer });
    return;
  }

  const client = await getClient(clientKey);
  if (!client) return;

  // Atualiza plano com base na assinatura vinculada à fatura
  let plan = client.plan || 'starter';
  const subId = invoice.subscription;
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      const priceId = sub.items.data[0]?.price?.id;
      const mapped  = priceId ? mapPriceToPlan(priceId) : null;
      if (mapped) plan = mapped;
    } catch (e) { /* mantém plano atual se não conseguir ler a assinatura */ }
  }

  client.plan             = plan;
  client.stripeStatus     = 'active';
  client.active           = true;
  client.usageCount       = 0;     // reset do ciclo mensal
  if (subId) client.stripeSubscriptionId = subId;

  await saveClient(clientKey, client);
  log('webhook_invoice_paid', { clientKey, plan });
}

// customer.subscription.updated — troca de plano, renovação, inadimplência
async function handleSubscriptionUpdated(stripe, subscription) {
  const clientKey = await getClientKey(stripe, subscription.customer);
  if (!clientKey) {
    log('webhook_sub_updated_no_client', { customerId: subscription.customer });
    return;
  }

  const client = await getClient(clientKey);
  if (!client) return;

  const priceId = subscription.items.data[0]?.price?.id;
  const plan    = (priceId ? mapPriceToPlan(priceId) : null) || client.plan || 'starter';

  client.plan                 = plan;
  client.stripeStatus         = subscription.status;
  client.stripeSubscriptionId = subscription.id;
  client.currentPeriodEnd     = subscription.current_period_end;

  // Bloqueia só nos status terminais — past_due tem período de graça
  if (['canceled', 'unpaid'].includes(subscription.status)) {
    client.active = false;
  }
  if (subscription.status === 'active') {
    client.active = true;
  }

  await saveClient(clientKey, client);
  log('webhook_sub_updated', { clientKey, plan, status: subscription.status });
}

// customer.subscription.deleted — assinatura encerrada
async function handleSubscriptionDeleted(stripe, subscription) {
  const clientKey = await getClientKey(stripe, subscription.customer);
  if (!clientKey) {
    log('webhook_sub_deleted_no_client', { customerId: subscription.customer });
    return;
  }

  const client = await getClient(clientKey);
  if (!client) return;

  client.stripeStatus         = 'canceled';
  client.stripeSubscriptionId = subscription.id;
  client.currentPeriodEnd     = subscription.current_period_end;
  client.plan                 = 'starter';
  client.active               = false;

  await saveClient(clientKey, client);
  log('webhook_sub_deleted', { clientKey });
}

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe não configurado.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

  // Lê o body bruto antes de qualquer parsing — obrigatório para verificar assinatura
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Falha ao ler body: ' + e.message });
  }

  // Verifica assinatura Stripe
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'stripe-signature ausente.' });
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    log('webhook_signature_error', { error: err.message });
    return res.status(400).json({ error: 'Assinatura inválida: ' + err.message });
  }

  log('webhook_received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'invoice.paid':
        await handleInvoicePaid(stripe, event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripe, event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripe, event.data.object);
        break;

      default:
        // Eventos não tratados são ignorados silenciosamente
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    log('webhook_handler_error', { type: event.type, error: err.message });
    return res.status(500).json({ error: 'Erro interno ao processar evento.' });
  }
}
