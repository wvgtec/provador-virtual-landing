// api/upload-url.js
// Gera URL assinada V4 do GCS para upload direto do browser.
// O widget faz PUT direto no GCS — a imagem nunca passa pelo servidor.

import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BUCKET  = process.env.GCS_BUCKET || 'mirage-tryon';
const EXPIRES = 300; // 5 minutos

function pemToBuffer(pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
}

function isValidClientKey(key) {
  return typeof key === 'string' && /^pvk_[a-f0-9]{32}$/.test(key);
}

async function isRateLimited(ip, prefix, maxRequests, windowSeconds) {
  const key = `${prefix}:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > maxRequests;
}

async function signedPutUrl(objectPath, contentType) {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datetime =
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    'T' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) + 'Z';
  const date = datetime.slice(0, 8);

  const credentialScope = `${date}/auto/storage/goog4_request`;
  const credential      = `${sa.client_email}/${credentialScope}`;
  const signedHeaders   = 'content-type;host';
  const canonicalHeaders = `content-type:${contentType}\nhost:storage.googleapis.com\n`;

  // Query string: parâmetros ordenados alfabeticamente
  const qParams = [
    ['X-Goog-Algorithm',     'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential',    credential],
    ['X-Goog-Date',          datetime],
    ['X-Goog-Expires',       String(EXPIRES)],
    ['X-Goog-SignedHeaders', signedHeaders],
  ].sort(([a], [b]) => a.localeCompare(b));

  const canonicalQS = qParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    'PUT',
    `/${BUCKET}/${objectPath}`,
    canonicalQS,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest));
  const hashHex = Buffer.from(hashBuf).toString('hex');

  const stringToSign = ['GOOG4-RSA-SHA256', datetime, credentialScope, hashHex].join('\n');

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(stringToSign));
  const sigHex = Buffer.from(sigBuf).toString('hex');

  return `https://storage.googleapis.com/${BUCKET}/${objectPath}?${canonicalQS}&X-Goog-Signature=${sigHex}`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (await isRateLimited(ip, 'rl:upload-url', 30, 60)) {
    return res.status(429).json({ error: 'Muitas requisições. Aguarde.' });
  }

  const { clientKey, contentType = 'image/jpeg' } = req.body || {};

  if (!clientKey || !isValidClientKey(clientKey)) {
    return res.status(400).json({ error: 'clientKey inválido.' });
  }

  const raw = await redis.get(`client:${clientKey}`);
  if (!raw) return res.status(403).json({ error: 'Chave de cliente inválida.' });
  const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!client.active) return res.status(403).json({ error: 'Acesso suspenso.' });

  const fileId     = randomUUID();
  const objectPath = `inputs/${fileId}.jpg`;
  const gcsUrl     = `https://storage.googleapis.com/${BUCKET}/${objectPath}`;
  const signedUrl  = await signedPutUrl(objectPath, contentType);

  return res.status(200).json({ signedUrl, gcsUrl, fileId });
}
