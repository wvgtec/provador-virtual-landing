// api/result.js
// Consultado pelo widget via polling para verificar o status do job.
// Retorna: pending | processing | done (+ resultImage) | error

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function isRateLimited(ip, prefix, maxRequests, windowSeconds) {
  const key = `${prefix}:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > maxRequests;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  // 30 polls por minuto por IP
  if (await isRateLimited(ip, 'rl:result', 30, 60)) {
    return res.status(429).json({ error: 'Polling muito frequente. Aguarde.' });
  }

  const { jobId } = req.query;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId obrigatório' });
  }

  // Valida formato UUID para evitar enumeração
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    return res.status(400).json({ error: 'jobId inválido.' });
  }

  const raw = await redis.get(`job:${jobId}`);

  if (!raw) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado' });
  }

  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (job.status === 'done') {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'result_poll_done', jobId, clientKey: job.clientKey || '' }));
  }

  // Retorna apenas os campos necessários — nunca devolve as imagens originais ou clientKey
  const safePayload = {
    status: job.status,
    ...(job.status === 'done'       && { resultImage: job.resultImage, completedAt: job.completedAt }),
    ...(job.status === 'processing' && { startedAt: job.startedAt }),
    ...(job.status === 'error'      && { error: 'Erro ao processar imagem.' }),
    ...(job.status === 'pending'    && { createdAt: job.createdAt }),
  };

  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json(safePayload);
}
