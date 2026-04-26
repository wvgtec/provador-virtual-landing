// api/save-lead.js
// Salva ou atualiza dados de lead para um job já concluído.
// Chamado pelo widget após o usuário preencher o formulário pós-resultado.
// POST { jobId, clientKey, lead: { name, email, whatsapp } }

import { Redis } from '@upstash/redis';

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

async function isRateLimited(ip) {
  const key = `rl:savelead:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 20;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown';

  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas requisições.' });
  }

  const { jobId, clientKey, lead } = req.body || {};

  if (!jobId || !clientKey || !isValidClientKey(clientKey)) {
    return res.status(400).json({ error: 'jobId e clientKey obrigatórios.' });
  }

  const name     = lead?.name?.trim()     || '';
  const email    = lead?.email?.trim()    || '';
  const whatsapp = lead?.whatsapp?.trim() || '';

  if (!name || !email || !whatsapp) {
    return res.status(400).json({ error: 'name, email e whatsapp são obrigatórios.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Formato de email inválido.' });
  }

  // Busca o job — valida existência e clientKey
  const raw = await redis.get(`job:${jobId}`);
  if (!raw) return res.status(404).json({ error: 'Job não encontrado ou expirado.' });
  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (job.clientKey && job.clientKey !== clientKey) {
    return res.status(403).json({ error: 'Job não pertence a este cliente.' });
  }
  if (job.status !== 'done') {
    return res.status(400).json({ error: 'Job ainda não foi concluído.' });
  }

  // Já existe lead para este job?
  const existing = await redis.get(`lead:${jobId}`);
  if (existing) {
    // Atualiza os dados do lead existente
    const prev = typeof existing === 'string' ? JSON.parse(existing) : existing;
    await redis.set(`lead:${jobId}`, JSON.stringify({ ...prev, name, email, whatsapp }), { ex: 86400 * 90 });
    return res.status(200).json({ ok: true, updated: true });
  }

  // Cria novo lead
  const ts         = Date.now();
  const resultUrl  = job.resultImage || '';
  const productUrl = job.productUrl  || '';

  await Promise.all([
    redis.zadd(`leads:${clientKey}`, { score: ts, member: jobId }),
    redis.set(`lead:${jobId}`, JSON.stringify({
      name, email, whatsapp,
      productUrl,
      resultUrl,
      jobId,
      completedAt: ts,
      clientKey,
    }), { ex: 86400 * 90 }),
    redis.zincrby(`products:${clientKey}`, 1, productUrl || 'desconhecido'),
  ]);

  return res.status(200).json({ ok: true });
}
