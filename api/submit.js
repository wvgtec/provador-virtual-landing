// api/submit.js
// Recebe a requisição do widget, valida cliente, lead e cria job na fila.
// Imagens chegam como URLs do GCS — nunca mais base64 no Redis.

import { Redis } from '@upstash/redis';
import { Client as QStashClient } from '@upstash/qstash';
import { randomUUID } from 'crypto';

const PROJECT_ID       = 'provador-virtual-494213';
const VALID_CATEGORIES = ['tops', 'bottoms', 'one-pieces', 'auto'];

// ─── Planos e limites ─────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  starter:    100,
  pro:        500,
  growth:     1000,
  scale:      5000,
  enterprise: Infinity,
};

const redis  = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN });

async function isRateLimited(ip, prefix, maxRequests, windowSeconds) {
  const key = `${prefix}:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > maxRequests;
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

function isSafeUrl(value) {
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc00:|fd)/.test(host)) return false;
    return true;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const {
    personImageUrl,  // URL do GCS — obrigatório
    garmentImage,    // URL da peça (loja ou GCS)
    garmentImageUrl, // alias para garmentImage
    category,
    clientKey,
    lead,            // { name, email, whatsapp }
    productUrl,      // URL da página do produto (analytics)
  } = req.body || {};

  // ─── clientKey obrigatório ────────────────────────────────────────────────
  if (!clientKey || !isValidClientKey(clientKey)) {
    return res.status(400).json({ error: 'clientKey obrigatório.' });
  }

  if (await isRateLimited(ip, 'rl:client', 20, 60)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde alguns segundos.' });
  }

  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return res.status(403).json({ error: 'Chave de cliente inválida.' });
  const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!client.active) return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com o suporte.' });

  // ─── Verificação de quota ─────────────────────────────────────────────────
  const planLimit    = PLAN_LIMITS[client.plan] ?? PLAN_LIMITS.starter;
  const currentUsage = Number(client.usageCount) || 0;
  if (currentUsage >= planLimit) {
    return res.status(429).json({
      error: `Limite do plano "${client.plan || 'starter'}" atingido (${planLimit} tryons). Faça upgrade para continuar.`,
      code:  'QUOTA_EXCEEDED',
      limit: planLimit,
      usage: currentUsage,
    });
  }

  // ─── Validação de domínio ─────────────────────────────────────────────────
  if (client.store) {
    const origin = req.headers.origin || req.headers.referer || '';
    if (origin) {
      const normalize = (s) =>
        s.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0].replace(/^www\./, '');
      const allowed  = normalize(client.store);
      const incoming = normalize(origin);
      const isAllowed = incoming === allowed || incoming.endsWith('.' + allowed);
      if (allowed && !isAllowed) {
        return res.status(403).json({ error: 'Origem não autorizada para esta chave.' });
      }
    }
  }

  // ─── Imagens ──────────────────────────────────────────────────────────────
  const finalPersonUrl  = personImageUrl;
  const finalGarmentUrl = garmentImageUrl || garmentImage;

  if (!finalPersonUrl || !finalPersonUrl.startsWith('https://storage.googleapis.com/')) {
    return res.status(400).json({ error: 'personImageUrl inválida. Use /api/upload-url primeiro.' });
  }
  if (!finalGarmentUrl) {
    return res.status(400).json({ error: 'garmentImage obrigatório.' });
  }
  if (!isSafeUrl(finalGarmentUrl)) {
    return res.status(400).json({ error: 'URL da peça não permitida.' });
  }

  // ─── Lead (opcional — pode ser enviado depois via /api/save-lead) ─────────
  const leadName     = lead?.name?.trim()     || '';
  const leadEmail    = lead?.email?.trim()    || '';
  const leadWhatsapp = lead?.whatsapp?.trim() || '';
  const hasLead      = !!(leadName && leadEmail && leadWhatsapp);

  if (hasLead && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) {
    return res.status(400).json({ error: 'Formato de email inválido.' });
  }

  const safeCategory    = VALID_CATEGORIES.includes(category) ? category : 'auto';
  const finalProductUrl = productUrl || finalGarmentUrl;

  // ─── Contagem de uso ──────────────────────────────────────────────────────
  const newCount = await redis.incr(`usage:${clientKey}`);
  await redis.set(`client:${clientKey}`, JSON.stringify({ ...client, usageCount: Number(newCount) || 0 }));

  // ─── Cria job — só metadados, sem imagens inline ──────────────────────────
  const jobId = randomUUID();

  await redis.set(
    `job:${jobId}`,
    JSON.stringify({
      status:          'pending',
      createdAt:       Date.now(),
      projectId:       PROJECT_ID,
      personImageUrl:  finalPersonUrl,
      garmentImageUrl: finalGarmentUrl,
      category:        safeCategory,
      clientKey,
      lead:            hasLead ? { name: leadName, email: leadEmail, whatsapp: leadWhatsapp } : null,
      productUrl:      finalProductUrl,
    }),
    { ex: 3600 }
  );

  await qstash.publishJSON({
    url:     `${process.env.APP_URL}/api/process`,
    body:    { jobId },
    retries: 3,
  });

  return res.status(202).json({
    jobId,
    status:  'pending',
    message: 'Job criado. Use /api/result?jobId=' + jobId + ' para acompanhar.',
  });
}
