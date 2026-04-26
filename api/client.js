// api/client.js
// API self-service para o cliente final (painel-cliente.html).
// Login: email + senha. Demais ações: clientKey + senha.

import { Redis } from '@upstash/redis';
import { timingSafeEqual, scryptSync } from 'crypto';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
  // Formato scrypt: "salt:hash" (salt 32 chars hex, hash 128 chars hex)
  if (stored.includes(':') && stored.length > 60) {
    try {
      const [salt, hash] = stored.split(':');
      const inputHash = scryptSync(String(input), salt, 64).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(inputHash, 'hex'));
    } catch { return false; }
  }
  // Legado: secret em base64url
  return safeCompare(input, stored);
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

async function isRateLimited(ip) {
  const key = `rl:cpanel:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 30;
}

// Autentica por clientKey + senha (usada após o login)
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

function sanitize(c) {
  const { secret: _s, passwordHash: _ph, ...safe } = c;
  return safe;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde 1 minuto.' });
  }

  const { action, clientKey, password, ...params } = req.body || {};

  // ─── LOGIN — sem auth prévia, recebe email + senha ────────────────────────
  if (action === 'login') {
    const { email } = params;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

    // Busca pelo índice de email
    let foundKey = await redis.get(`client_email:${email.toLowerCase().trim()}`);

    // Fallback: scan completo (migração de clientes sem índice)
    if (!foundKey) {
      const allKeys = [];
      let cursor = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: 'client:*', count: 100 });
        cursor = Number(next);
        allKeys.push(...keys);
      } while (cursor !== 0);

      for (const k of allKeys) {
        const r = await redis.get(k);
        if (!r) continue;
        const c = typeof r === 'string' ? JSON.parse(r) : r;
        if (c.email?.toLowerCase() === email.toLowerCase().trim()) {
          foundKey = k.replace('client:', '');
          // Reconstrói o índice silenciosamente
          await redis.set(`client_email:${email.toLowerCase().trim()}`, foundKey);
          break;
        }
      }
    }

    if (!foundKey) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const raw = await redis.get(`client:${foundKey}`);
    if (!raw) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!client.active) return res.status(403).json({ error: 'Conta suspensa. Entre em contato com o suporte.' });

    const stored = client.passwordHash || client.secret || '';
    if (!verifyPassword(password, stored)) return res.status(401).json({ error: 'Credenciais inválidas.' });

    return res.json({ ok: true, clientKey: foundKey, client: sanitize(client) });
  }

  // ─── Demais ações — requer clientKey + senha ──────────────────────────────
  const client = await authenticate(clientKey, password);
  if (!client) return res.status(401).json({ error: 'Não autorizado.' });

  try {
    // ME — retorna dados do próprio cliente
    if (action === 'me') {
      return res.json({ ok: true, client: sanitize(client) });
    }

    // JOBS — lista jobs paginado com filtro opcional por status
    if (action === 'jobs') {
      const page   = Math.max(1, Number(params.page)   || 1);
      const limit  = Math.min(100, Number(params.limit) || 30);
      const status = params.status || '';

      const jobKeys = [];
      let cursor = 0;
      do {
        const [next, keys] = await redis.scan(cursor, { match: 'job:*', count: 200 });
        cursor = Number(next);
        jobKeys.push(...keys);
      } while (cursor !== 0);

      const raws = await Promise.all(jobKeys.map(k => redis.get(k)));
      let jobs = raws
        .map((r, i) => {
          const obj = typeof r === 'string' ? JSON.parse(r) : r;
          if (!obj || obj.clientKey !== clientKey) return null;
          if (!obj.jobId) obj.jobId = jobKeys[i].replace('job:', '');
          return obj;
        })
        .filter(Boolean);

      if (status) jobs = jobs.filter(j => j.status === status);
      jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      const total = jobs.length;
      const start = (page - 1) * limit;
      return res.json({ ok: true, jobs: jobs.slice(start, start + limit), total, page, limit });
    }

    // LEADS — via sorted set leads:${clientKey}
    if (action === 'leads') {
      const page  = Math.max(1, Number(params.page)   || 1);
      const limit = Math.min(200, Number(params.limit) || 50);

      const total = await redis.zcard(`leads:${clientKey}`);
      if (!total) return res.json({ ok: true, leads: [], total: 0 });

      const start  = (page - 1) * limit;
      const jobIds = await redis.zrange(`leads:${clientKey}`, start, start + limit - 1, { rev: true });
      if (!jobIds?.length) return res.json({ ok: true, leads: [], total });

      const raws = await Promise.all(jobIds.map(id => redis.get(`lead:${id}`)));
      const leads = raws.map(r => (typeof r === 'string' ? JSON.parse(r) : r)).filter(Boolean);
      return res.json({ ok: true, leads, total, page, limit });
    }

    // PRODUCTS — ranking de produtos via sorted set
    if (action === 'products') {
      const limit = Math.min(50, Number(params.limit) || 20);
      const raw   = await redis.zrange(`products:${clientKey}`, 0, limit - 1, { rev: true, withScores: true });
      const products = [];
      for (let i = 0; i < (raw?.length || 0); i += 2) {
        products.push({ url: raw[i], count: Number(raw[i + 1]) });
      }
      return res.json({ ok: true, products });
    }

    // UPDATE — atualiza dados da conta
    if (action === 'update') {
      const { name, email, store } = params;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Formato de email inválido.' });
      }
      // Unicidade de email
      if (email && email !== client.email) {
        const existing = await redis.get(`client_email:${email.toLowerCase()}`);
        if (existing && existing !== clientKey) return res.status(409).json({ error: 'Este email já está em uso.' });
        if (client.email) await redis.del(`client_email:${client.email.toLowerCase()}`);
        await redis.set(`client_email:${email.toLowerCase()}`, clientKey);
        client.email = email;
      }
      if (name  !== undefined) client.name  = String(name).trim();
      if (store !== undefined) client.store = String(store).trim();
      await redis.set(`client:${clientKey}`, JSON.stringify(client));
      return res.json({ ok: true, client: sanitize(client) });
    }

    return res.status(400).json({ error: 'Ação inválida.' });

  } catch (err) {
    console.error('[client-api] Erro:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
