// api/result.js
// Consultado pelo widget via polling para verificar o status do job.
// Retorna: pending | processing | done (+ imagem) | error

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { jobId } = req.query;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId obrigatório' });
  }

  const raw = await redis.get(`job:${jobId}`);

  if (!raw) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado' });
  }

  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Cache-Control agressivo para evitar que CDNs cacheem respostas de polling
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json(job);
}
