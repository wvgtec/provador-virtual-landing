// api/process.js
// Chamado pelo QStash. Chama Vertex AI, salva resultado no GCS e registra lead.
// NUNCA deve ser chamado diretamente pelo browser — só pelo QStash.

import { Redis } from '@upstash/redis';
import { Receiver } from '@upstash/qstash';

const redis  = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const BUCKET = process.env.GCS_BUCKET || 'mirage-tryon';

// ─── Google Auth ──────────────────────────────────────────────────────────────

function pemToBuffer(pem) {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
}

async function getGoogleAccessToken() {
  const sa  = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsignedToken = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(unsignedToken));
  const jwt = `${unsignedToken}.${Buffer.from(signature).toString('base64url')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Falha ao obter access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ─── SSRF protection ──────────────────────────────────────────────────────────

function isSafeUrl(value) {
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc00:|fd)/.test(host)) return false;
    return true;
  } catch { return false; }
}

// ─── GCS Upload ───────────────────────────────────────────────────────────────

async function uploadToGCS(accessToken, objectPath, buffer, contentType = 'image/png') {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GCS upload falhou: ${res.status} ${err}`);
  }
  return `https://storage.googleapis.com/${BUCKET}/${objectPath}`;
}

// ─── Vertex AI Virtual Try-On ─────────────────────────────────────────────────

async function callVertexTryOn({ projectId, personImageUrl, garmentImageUrl, category, accessToken }) {
  const LOCATION = 'us-central1';
  const MODEL    = 'virtual-try-on-001';
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const toBase64 = async (value) => {
    if (!value) throw new Error('Imagem não informada');
    if (!value.startsWith('http') && !value.startsWith('//')) {
      return value.includes(',') ? value.split(',')[1] : value;
    }
    if (!isSafeUrl(value)) throw new Error('URL de imagem não permitida.');
    const res = await fetch(value.startsWith('//') ? 'https:' + value : value);
    if (!res.ok) throw new Error(`Falha ao buscar imagem: ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  };

  const [personB64, productB64] = await Promise.all([
    toBase64(personImageUrl),
    toBase64(garmentImageUrl),
  ]);

  console.log('[Vertex] request | category:', category);

  const response = await fetch(endpoint, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{
        personImage:   { image: { bytesBase64Encoded: personB64 } },
        productImages: [{ image: { bytesBase64Encoded: productB64 } }],
      }],
      parameters: { sampleCount: 1, safetySetting: 'block_few', personGeneration: 'allow_all' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vertex AI retornou ${response.status}: ${err}`);
  }

  const data = await response.json();
  const imageBase64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!imageBase64) throw new Error('Vertex AI não retornou imagem: ' + JSON.stringify(data));
  return imageBase64;
}

// ─── QStash Receiver ──────────────────────────────────────────────────────────

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey:    process.env.QSTASH_NEXT_SIGNING_KEY,
});

// ─── Handler principal ────────────────────────────────────────────────────────

export default async function processHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verifica assinatura QStash
  try {
    const signature = req.headers['upstash-signature'];
    if (!signature) return res.status(401).json({ error: 'Assinatura ausente.' });
    const isValid = await receiver.verify({ signature, body: JSON.stringify(req.body), clockTolerance: 60 });
    if (!isValid) return res.status(401).json({ error: 'Assinatura inválida.' });
  } catch (e) {
    return res.status(401).json({ error: 'Falha na verificação: ' + e.message });
  }

  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId obrigatório' });

  const raw = await redis.get(`job:${jobId}`);
  if (!raw) return res.status(404).json({ error: 'Job não encontrado ou expirado' });
  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const { personImageUrl, garmentImageUrl, category, projectId, clientKey, lead, productUrl } = job;

  await redis.set(`job:${jobId}`, JSON.stringify({ status: 'processing', startedAt: Date.now() }), { ex: 3600 });

  try {
    // Token único para Vertex AI + GCS
    const accessToken = await getGoogleAccessToken();

    const imageBase64 = await callVertexTryOn({
      projectId, personImageUrl, garmentImageUrl, category, accessToken,
    });

    // Salva resultado no GCS (não mais inline no Redis)
    const outputPath = `outputs/${jobId}.png`;
    const resultUrl  = await uploadToGCS(accessToken, outputPath, Buffer.from(imageBase64, 'base64'), 'image/png');

    // Atualiza status com URL do resultado
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({ status: 'done', resultImage: resultUrl, completedAt: Date.now() }),
      { ex: 3600 }
    );

    // ─── Registra lead e analytics ────────────────────────────────────────
    if (clientKey && lead) {
      const ts = Date.now();
      const finalProductUrl = productUrl || garmentImageUrl;
      await Promise.all([
        // Índice de leads por cliente (sorted set, score = timestamp)
        redis.zadd(`leads:${clientKey}`, { score: ts, member: jobId }),
        // Dados completos do lead
        redis.set(`lead:${jobId}`, JSON.stringify({
          name:        lead.name,
          email:       lead.email,
          whatsapp:    lead.whatsapp,
          productUrl:  finalProductUrl,
          resultUrl,
          jobId,
          completedAt: ts,
          clientKey,
        }), { ex: 86400 * 90 }), // 90 dias
        // Contador de produto por URL (sorted set, score = count)
        redis.zincrby(`products:${clientKey}`, 1, finalProductUrl),
      ]);
    }

    return res.status(200).json({ jobId, status: 'done' });

  } catch (err) {
    console.error(`[process] Erro no job ${jobId}:`, err);
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({ status: 'error', error: err.message, failedAt: Date.now() }),
      { ex: 3600 }
    );
    return res.status(200).json({ jobId, status: 'error', error: 'Erro ao processar imagem.' });
  }
}
