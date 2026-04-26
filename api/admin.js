// api/admin.js
// Gerencia clientes do Provador Virtual via Redis (Upstash).
// CORS tratado globalmente pelo vercel.json.

import { Redis } from '@upstash/redis';
import { randomBytes, timingSafeEqual, scryptSync } from 'crypto';
import Stripe from 'stripe';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Stripe — ativo só se a chave estiver configurada
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' })
  : null;

// ─── Helpers de autenticação ──────────────────────────────────────────────────
function generateKey()    { return 'pvk_' + randomBytes(16).toString('hex'); }
function generateSecret() { return randomBytes(20).toString('base64url'); }

function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch { return false; }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(input, stored) {
  if (!stored || !input) return false;
  // Formato scrypt: "salt:hash" com salt de 32 chars hex
  if (stored.includes(':') && stored.length > 60) {
    try {
      const [salt, hash] = stored.split(':');
      const inputHash = scryptSync(String(input), salt, 64).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(inputHash, 'hex'));
    } catch { return false; }
  }
  // Legado: secret em base64url (comparação direta)
  return safeCompare(input, stored);
}

function getSecret(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

async function isRateLimited(ip, prefix, maxRequests, windowSeconds) {
  const key = `${prefix}:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > maxRequests;
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (await isRateLimited(ip, 'rl:admin', 20, 60)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.' });
  }

  const body   = req.method === 'POST' ? (req.body || {}) : {};
  const action = req.query.action || body.action;

  // ─── LOGIN (sem auth) ─────────────────────────────────────────────────────
  if (action === 'login') {
    const adminEmail  = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
    const adminSecret = process.env.ADMIN_SECRET || '';
    const { email, password } = body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    if (email.toLowerCase().trim() !== adminEmail) return res.status(401).json({ error: 'Credenciais inválidas.' });
    if (!safeCompare(password, adminSecret)) return res.status(401).json({ error: 'Credenciais inválidas.' });
    return res.json({ ok: true });
  }

  // ─── Autenticação para demais ações ──────────────────────────────────────
  const secret   = getSecret(req);
  const expected = process.env.ADMIN_SECRET || '';
  if (!secret || !safeCompare(secret, expected)) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {

    // LIST
    if (action === 'list') {
      const redisKeys = [];
      let cursor = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: 'client:*', count: 100 });
        cursor = Number(next);
        redisKeys.push(...keys);
      } while (cursor !== 0);
      if (!redisKeys.length) return res.json({ clients: [] });
      const raws = await Promise.all(redisKeys.map(k => redis.get(k)));
      const clients = raws
        .map((r, i) => {
          const obj = typeof r === 'string' ? JSON.parse(r) : r;
          if (!obj) return null;
          if (!obj.key) obj.key = redisKeys[i].replace('client:', '');
          // Garante índice de email (migração silenciosa)
          if (obj.email && obj.key) {
            redis.set(`client_email:${obj.email.toLowerCase()}`, obj.key).catch(() => {});
          }
          // Remove campos sensíveis da listagem
          const { secret: _s, passwordHash: _ph, ...safe } = obj;
          return safe;
        })
        .filter(Boolean)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return res.json({ clients });
    }

    // CREATE
    if (action === 'create') {
      const { name, email, store, plan, password } = body;
      if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Formato de email inválido.' });

      // Unicidade de email
      const existingKey = await redis.get(`client_email:${email.toLowerCase()}`);
      if (existingKey) return res.status(409).json({ error: 'Este email já está cadastrado em outra conta.' });

      const key    = generateKey();
      const secret = generateSecret();
      const client = {
        key, secret, name, email,
        store:      store || '',
        plan:       plan  || 'starter',
        active:     true,
        usageCount: 0,
        createdAt:  Date.now(),
      };
      if (password && password.length >= 6) {
        client.passwordHash = hashPassword(password);
      }
      await redis.set(`client:${key}`, JSON.stringify(client));
      await redis.set(`client_email:${email.toLowerCase()}`, key);
      const { secret: _s, passwordHash: _ph, ...safeClient } = client;
      return res.status(201).json({ ok: true, key, secret, client: safeClient });
    }

    // SET PASSWORD — admin define/redefine a senha do cliente
    if (action === 'setPassword') {
      const { key, password } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      if (!password || String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado.' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      client.passwordHash = hashPassword(password);
      await redis.set(`client:${key}`, JSON.stringify(client));
      return res.json({ ok: true });
    }

    // TOGGLE
    if (action === 'toggle') {
      const { key } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      client.active = !client.active;
      await redis.set(`client:${key}`, JSON.stringify(client));
      return res.json({ ok: true, active: client.active });
    }

    // DELETE
    if (action === 'delete') {
      const { key } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      const raw = await redis.get(`client:${key}`);
      if (raw) {
        const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (client.email) await redis.del(`client_email:${client.email.toLowerCase()}`);
      }
      await redis.del(`client:${key}`);
      return res.json({ ok: true });
    }

    // ─── GESTÃO DE PLANOS (Produtos) ────────────────────────────────────────

    // LIST PLANS
    if (action === 'listPlans') {
      const ids = await redis.smembers('plans:index');
      if (!ids?.length) return res.json({ ok: true, plans: [] });
      const raws = await Promise.all(ids.map(id => redis.get(`plan:${id}`)));
      const plans = raws.map(r => typeof r === 'string' ? JSON.parse(r) : r).filter(Boolean);
      plans.sort((a, b) => (a.price || 0) - (b.price || 0));
      return res.json({ ok: true, plans });
    }

    // CREATE PLAN
    if (action === 'createPlan') {
      const { name, tryons, price, overage } = body;
      if (!name) return res.status(400).json({ error: 'name é obrigatório.' });
      const id   = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 32) + '_' + Date.now().toString(36);
      const plan = {
        id,
        name,
        tryons:   Number(tryons)  || 0,
        price:    Number(price)   || 0,
        overage:  Number(overage) || 0,
        createdAt: Date.now(),
      };

      // Sincroniza com Stripe — cria Produto + Preço recorrente mensal em BRL
      if (stripe && plan.price > 0) {
        try {
          const stripeProduct = await stripe.products.create({
            name,
            metadata: { planId: id, source: 'mirage-admin' },
          });
          const stripePrice = await stripe.prices.create({
            product:    stripeProduct.id,
            unit_amount: Math.round(plan.price * 100), // centavos
            currency:   'brl',
            recurring:  { interval: 'month' },
            metadata:   { planId: id },
          });
          plan.stripeProductId = stripeProduct.id;
          plan.stripePriceId   = stripePrice.id;
        } catch (e) {
          console.error('[admin] createPlan Stripe error:', e.message);
          // Continua sem Stripe — plano é salvo no Redis normalmente
        }
      }

      await redis.set(`plan:${id}`, JSON.stringify(plan));
      await redis.sadd('plans:index', id);
      return res.status(201).json({ ok: true, plan });
    }

    // UPDATE PLAN
    if (action === 'updatePlan') {
      const { id, name, tryons, price, overage } = body;
      if (!id) return res.status(400).json({ error: 'id é obrigatório.' });
      const raw = await redis.get(`plan:${id}`);
      if (!raw) return res.status(404).json({ error: 'Plano não encontrado.' });
      const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;

      const priceChanged = price !== undefined && Number(price) !== plan.price;
      const nameChanged  = name  !== undefined && name !== plan.name;

      if (name    !== undefined) plan.name    = name;
      if (tryons  !== undefined) plan.tryons  = Number(tryons);
      if (price   !== undefined) plan.price   = Number(price);
      if (overage !== undefined) plan.overage = Number(overage);

      // Sincroniza com Stripe
      if (stripe && plan.stripeProductId) {
        try {
          // Atualiza nome do produto se mudou
          if (nameChanged) {
            await stripe.products.update(plan.stripeProductId, { name: plan.name });
          }
          // Preço não pode ser editado no Stripe — arquiva o antigo e cria novo
          if (priceChanged && plan.price > 0) {
            if (plan.stripePriceId) {
              await stripe.prices.update(plan.stripePriceId, { active: false });
            }
            const newPrice = await stripe.prices.create({
              product:     plan.stripeProductId,
              unit_amount: Math.round(plan.price * 100),
              currency:    'brl',
              recurring:   { interval: 'month' },
              metadata:    { planId: id },
            });
            plan.stripePriceId = newPrice.id;
          }
        } catch (e) {
          console.error('[admin] updatePlan Stripe error:', e.message);
        }
      } else if (stripe && !plan.stripeProductId && plan.price > 0) {
        // Plano antigo sem produto Stripe — cria agora
        try {
          const stripeProduct = await stripe.products.create({
            name: plan.name,
            metadata: { planId: id, source: 'mirage-admin' },
          });
          const stripePrice = await stripe.prices.create({
            product:     stripeProduct.id,
            unit_amount: Math.round(plan.price * 100),
            currency:    'brl',
            recurring:   { interval: 'month' },
            metadata:    { planId: id },
          });
          plan.stripeProductId = stripeProduct.id;
          plan.stripePriceId   = stripePrice.id;
        } catch (e) {
          console.error('[admin] updatePlan Stripe create error:', e.message);
        }
      }

      await redis.set(`plan:${id}`, JSON.stringify(plan));
      return res.json({ ok: true, plan });
    }

    // DELETE PLAN
    if (action === 'deletePlan') {
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'id é obrigatório.' });

      // Arquiva produto no Stripe antes de deletar do Redis
      if (stripe) {
        const planRaw = await redis.get(`plan:${id}`);
        if (planRaw) {
          const plan = typeof planRaw === 'string' ? JSON.parse(planRaw) : planRaw;
          try {
            if (plan.stripePriceId)   await stripe.prices.update(plan.stripePriceId, { active: false });
            if (plan.stripeProductId) await stripe.products.update(plan.stripeProductId, { active: false });
          } catch (e) {
            console.error('[admin] deletePlan Stripe error:', e.message);
          }
        }
      }

      await redis.del(`plan:${id}`);
      await redis.srem('plans:index', id);
      return res.json({ ok: true });
    }

    // SYNC PLANS — força sincronização de todos os planos sem stripePriceId para o Stripe
    if (action === 'syncPlans') {
      if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });

      const ids = await redis.smembers('plans:index');
      if (!ids?.length) return res.json({ ok: true, synced: [], skipped: [] });

      const raws = await Promise.all(ids.map(id => redis.get(`plan:${id}`)));
      const plans = raws.map(r => (typeof r === 'string' ? JSON.parse(r) : r)).filter(Boolean);

      const synced  = [];
      const skipped = [];
      const errors  = [];

      for (const plan of plans) {
        // Já tem Stripe — pula
        if (plan.stripeProductId && plan.stripePriceId) {
          skipped.push({ id: plan.id, name: plan.name, reason: 'já sincronizado' });
          continue;
        }
        if (!plan.price || plan.price <= 0) {
          skipped.push({ id: plan.id, name: plan.name, reason: 'preço zero' });
          continue;
        }
        try {
          // Se tem produto mas não tem preço (caso parcial)
          let productId = plan.stripeProductId;
          if (!productId) {
            const stripeProduct = await stripe.products.create({
              name: plan.name,
              metadata: { planId: plan.id, source: 'mirage-admin-sync' },
            });
            productId = stripeProduct.id;
            plan.stripeProductId = productId;
          }
          const stripePrice = await stripe.prices.create({
            product:     productId,
            unit_amount: Math.round(plan.price * 100),
            currency:    'brl',
            recurring:   { interval: 'month' },
            metadata:    { planId: plan.id },
          });
          plan.stripePriceId = stripePrice.id;
          await redis.set(`plan:${plan.id}`, JSON.stringify(plan));
          synced.push({ id: plan.id, name: plan.name, stripePriceId: stripePrice.id });
        } catch (e) {
          errors.push({ id: plan.id, name: plan.name, error: e.message });
        }
      }

      return res.json({ ok: true, synced, skipped, errors });
    }

    // CHANGE PLAN
    if (action === 'changePlan') {
      const { key, plan } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      client.plan = plan;
      await redis.set(`client:${key}`, JSON.stringify(client));
      return res.json({ ok: true, plan });
    }

    // RESET USAGE
    if (action === 'resetUsage') {
      const { key } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      client.usageCount = 0;
      await redis.set(`client:${key}`, JSON.stringify(client));
      await redis.set(`usage:${key}`, 0);
      return res.json({ ok: true });
    }

    // JOBS
    if (action === 'jobs') {
      const limit  = Math.min(Number(req.query.limit  || body.limit)  || 50, 200);
      const filter = req.query.clientKey || body.clientKey || '';
      const jobKeys = [];
      let cursor = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: 'job:*', count: 200 });
        cursor = Number(next);
        jobKeys.push(...keys);
      } while (cursor !== 0);
      if (!jobKeys.length) return res.json({ jobs: [] });
      const raws = await Promise.all(jobKeys.map(k => redis.get(k)));
      let jobs = raws
        .map((r, i) => {
          const obj = typeof r === 'string' ? JSON.parse(r) : r;
          if (!obj) return null;
          if (!obj.jobId) obj.jobId = jobKeys[i].replace('job:', '');
          return obj;
        })
        .filter(Boolean);
      if (filter) jobs = jobs.filter(j => j.clientKey === filter);
      jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.json({ jobs: jobs.slice(0, limit) });
    }

    // UPDATE
    if (action === 'update') {
      const { key, name, email, store } = body;
      if (!key || !isValidClientKey(key)) return res.status(400).json({ error: 'key inválida.' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (email !== undefined && email !== client.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Formato de email inválido.' });
        const existingKey = await redis.get(`client_email:${email.toLowerCase()}`);
        if (existingKey && existingKey !== key) return res.status(409).json({ error: 'Este email já está em uso por outra conta.' });
        if (client.email) await redis.del(`client_email:${client.email.toLowerCase()}`);
        await redis.set(`client_email:${email.toLowerCase()}`, key);
        client.email = email;
      }
      if (name  !== undefined) client.name  = name;
      if (store !== undefined) client.store = store;
      await redis.set(`client:${key}`, JSON.stringify(client));
      const { secret: _s, passwordHash: _ph, ...safeClient } = client;
      return res.json({ ok: true, client: safeClient });
    }

    return res.status(400).json({ error: 'Ação inválida.' });

  } catch (err) {
    console.error('[admin] Erro:', err);
    return res.status(500).json({ error: 'Erro interno no servidor.' });
  }
}
