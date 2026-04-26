// api/admin.js
// Gerencia clientes do Provador Virtual via Redis (Upstash).
// CORS tratado globalmente pelo vercel.json — sem headers CORS aqui para evitar duplicatas.

import { Redis } from '@upstash/redis';
import { randomBytes } from 'crypto';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function generateKey() {
  return 'pvk_' + randomBytes(16).toString('hex');
}

function getSecret(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = getSecret(req);
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }

  const action = req.query.action || req.body?.action;

  try {
    // LIST
    if (action === 'list') {
      const redisKeys = await redis.keys('client:*');
      if (!redisKeys.length) return res.json({ clients: [] });
      const raws = await Promise.all(redisKeys.map(k => redis.get(k)));
      const clients = raws
        .map((r, i) => {
          const obj = typeof r === 'string' ? JSON.parse(r) : r;
          if (!obj) return null;
          // Compatibilidade: injeta o key caso o objeto antigo não tenha
          if (!obj.key) obj.key = redisKeys[i].replace('client:', '');
          return obj;
        })
        .filter(Boolean)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return res.json({ clients });
    }

    // CREATE
    if (action === 'create') {
      const { name, email, store, plan } = req.body || {};
      if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });
      const key = generateKey();
      const client = {
        key, name, email,
        store: store || '',
        plan: plan || 'starter',
        active: true,
        usageCount: 0,
        createdAt: Date.now(),
      };
      await redis.set(`client:${key}`, JSON.stringify(client));
      return res.status(201).json({ ok: true, key, client });
    }

    // TOGGLE
    if (action === 'toggle') {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key é obrigatório' });
      const raw = await redis.get(`client:${key}`);
      if (!raw) return res.status(404).json({ error: 'Cliente não encontrado' });
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      client.active = !client.active;
      await redis.set(`client:${key}`, JSON.stringify(client));
      return res.json({ ok: true, active: client.active });
    }

    // DELETE
    if (action === 'delete') {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key é obrigatório' });
      await redis.del(`client:${key}`);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Ação inválida: ' + action });

  } catch (err) {
    console.error('[admin] Erro:', err);
    return res.status(500).json({ error: 'Erro interno', detail: err.message });
  }
}
