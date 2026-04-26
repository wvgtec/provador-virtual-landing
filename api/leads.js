// api/leads.js
// Retorna leads e analytics por clientKey.
// Auth: ADMIN_SECRET (Bearer) para acesso total, ou clientKey + X-Client-Secret para acesso próprio.

import { Redis } from '@upstash/redis';
import { timingSafeEqual } from 'crypto';

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

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

async function isRateLimited(ip) {
  const key = `rl:leads:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 30;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas requisições.' });
  }

  // ─── Autenticação ─────────────────────────────────────────────────────────
  const auth         = req.headers.authorization || '';
  const bearerSecret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const isAdmin      = bearerSecret && safeCompare(bearerSecret, process.env.ADMIN_SECRET || '');

  const { key: clientKey, action = 'leads', limit = '50' } = req.query;

  if (!isAdmin) {
    if (!clientKey || !isValidClientKey(clientKey)) {
      return res.status(401).json({ error: 'Autenticação necessária.' });
    }
    const clientSecret = req.headers['x-client-secret'] || '';
    const rawClient    = await redis.get(`client:${clientKey}`);
    if (!rawClient) return res.status(403).json({ error: 'Chave inválida.' });
    const clientObj = typeof rawClient === 'string' ? JSON.parse(rawClient) : rawClient;
    if (!clientObj.secret || !safeCompare(clientSecret, clientObj.secret)) {
      return res.status(403).json({ error: 'Senha incorreta.' });
    }
  }

  if (!clientKey || !isValidClientKey(clientKey)) {
    return res.status(400).json({ error: 'Parâmetro key (clientKey) obrigatório.' });
  }

  const n = Math.min(parseInt(limit, 10) || 50, 200);

  try {
    // ─── Lista de leads ───────────────────────────────────────────────────
    if (action === 'leads') {
      const jobIds = await redis.zrange(`leads:${clientKey}`, 0, n - 1, { rev: true });
      if (!jobIds || !jobIds.length) return res.json({ leads: [], total: 0 });

      const raws = await Promise.all(jobIds.map(id => redis.get(`lead:${id}`)));
      const leads = raws
        .map(r => r ? (typeof r === 'string' ? JSON.parse(r) : r) : null)
        .filter(Boolean);

      const total = await redis.zcard(`leads:${clientKey}`);
      return res.json({ leads, total: Number(total) || 0 });
    }

    // ─── Analytics ───────────────────────────────────────────────────────
    if (action === 'analytics') {
      const [totalJobsRaw, topProductsRaw, totalLeadsRaw] = await Promise.all([
        redis.get(`usage:${clientKey}`),
        redis.zrange(`products:${clientKey}`, 0, 9, { rev: true }),
        redis.zcard(`leads:${clientKey}`),
      ]);

      // Busca contagens individuais para cada produto
      const topProducts = await Promise.all(
        (topProductsRaw || []).map(async (url) => {
          const count = await redis.zscore(`products:${clientKey}`, url);
          return { url: String(url), count: Number(count) || 0 };
        })
      );

      return res.json({
        totalJobs:   Number(totalJobsRaw)   || 0,
        totalLeads:  Number(totalLeadsRaw)  || 0,
        topProducts,
      });
    }

    return res.status(400).json({ error: 'action inválida. Use: leads, analytics' });

  } catch (err) {
    console.error('[leads] Erro:', err);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}
