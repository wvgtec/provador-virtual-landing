// api/create-checkout.js
// Cria sessão de checkout Stripe para assinatura recorrente.
// Autenticado via ADMIN_SECRET (usado pelo painel admin) ou clientKey + password (painel cliente).
// Retorna a URL de checkout para redirecionar o usuário.

import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { timingSafeEqual, scryptSync } from 'crypto';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const APP_URL = process.env.APP_URL || 'https://mirageai.com.br';

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

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
  if (stored.includes(':') && stored.length > 60) {
    try {
      const [salt, hash] = stored.split(':');
      const inputHash = scryptSync(String(input), salt, 64).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(inputHash, 'hex'));
    } catch { return false; }
  }
  return safeCompare(input, stored);
}

async function isRateLimited(ip) {
  const key = `rl:checkout:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 10;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe não configurado.' });
  }

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde 1 minuto.' });
  }

  const { clientKey, planId, password } = req.body || {};

  if (!clientKey || !isValidClientKey(clientKey)) {
    return res.status(400).json({ error: 'clientKey inválido.' });
  }
  if (!planId) {
    return res.status(400).json({ error: 'planId obrigatório.' });
  }

  // Autenticação: aceita ADMIN_SECRET via Bearer ou clientKey + password
  const authHeader  = req.headers.authorization || '';
  const adminSecret = process.env.ADMIN_SECRET   || '';
  const isAdmin     = authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7).trim(), adminSecret);
  const isClient    = !!password;

  if (!isAdmin && !isClient) {
    return res.status(401).json({ error: 'Autenticação obrigatória.' });
  }

  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const client = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Autenticação do cliente via senha
  if (isClient && !isAdmin) {
    const stored = client.passwordHash || client.secret || '';
    if (!verifyPassword(password, stored)) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
  }

  // Busca o plano e o stripePriceId correspondente
  const planRaw = await redis.get(`plan:${planId}`);
  if (!planRaw) return res.status(404).json({ error: 'Plano não encontrado.' });
  const plan = typeof planRaw === 'string' ? JSON.parse(planRaw) : planRaw;
  if (!plan.stripePriceId) {
    return res.status(400).json({ error: 'Plano sem preço Stripe. Edite o plano no admin para sincronizar.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

  try {
    // Garante customer Stripe e salva índice de busca
    let customerId = client.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    client.email,
        name:     client.name,
        metadata: { clientKey },
      });
      customerId = customer.id;
      client.stripeCustomerId = customerId;
      await Promise.all([
        redis.set(`client:${clientKey}`, JSON.stringify(client)),
        redis.set(`stripe:customer:${customerId}`, clientKey),
      ]);
    } else {
      // Garante que o índice existe (migração silenciosa)
      await redis.set(`stripe:customer:${customerId}`, clientKey);
    }

    const session = await stripe.checkout.sessions.create({
      mode:      'subscription',
      customer:  customerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: `${APP_URL}/painel-cliente.html?checkout=success`,
      cancel_url:  `${APP_URL}/painel-cliente.html?checkout=canceled`,
      metadata: { clientKey, planId },
      subscription_data: {
        metadata: { clientKey, planId },
      },
    });

    console.log(JSON.stringify({
      ts: new Date().toISOString(), event: 'checkout_created',
      clientKey, planId, stripePriceId: plan.stripePriceId, sessionId: session.id,
    }));

    return res.json({ ok: true, url: session.url, sessionId: session.id, plan: plan.name });

  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), event: 'checkout_error',
      clientKey, error: err.message,
    }));
    return res.status(500).json({ error: 'Erro ao criar checkout: ' + err.message });
  }
}
