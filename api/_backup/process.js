// api/process.js
// Chamado pelo QStash (fila). Faz a chamada real ao Vertex AI e salva o resultado no Redis.
// NUNCA deve ser chamado diretamente pelo browser — só pelo QStash.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── Google Auth ─────────────────────────────────────────────────────────────

/**
 * Gera um token de acesso OAuth2 usando a Service Account do Google.
 * Usa JWT assinado com RS256 — sem depender do SDK do Google (mais leve).
 */
async function getGoogleAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const unsignedToken = `${encode(header)}.${encode(payload)}`;

  // Importa a chave privada RSA
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    Buffer.from(unsignedToken)
  );

  const jwt = `${unsignedToken}.${Buffer.from(signature).toString('base64url')}`;

  // Troca o JWT por um access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Falha ao obter access token Google: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

function pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return Buffer.from(b64, 'base64');
}

// ─── Vertex AI Virtual Try-On ─────────────────────────────────────────────────

async function callVertexTryOn({ projectId, personImage, garmentImage, category }) {
  const accessToken = await getGoogleAccessToken();
  const LOCATION = 'us-central1';
  const MODEL = 'virtual-try-on-001';

  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;

  const stripPrefix = (value) => value.includes(',') ? value.split(',')[1] : value;

  // Converte para base64 — aceita base64 puro, data URI, URL http/https ou URL relativa ao protocolo (//)
  const toBase64 = async (value) => {
    if (!value) throw new Error('Imagem não informada');
    // Já é base64 ou data URI
    if (!value.startsWith('http') && !value.startsWith('//')) {
      return stripPrefix(value);
    }
    // URL relativa ao protocolo → adiciona https:
    const url = value.startsWith('//') ? 'https:' + value : value;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao buscar imagem: ${url} → ${res.status}`);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  };

  const personB64  = await toBase64(personImage);
  const productB64 = await toBase64(garmentImage);

  console.log('[Vertex] personB64 len:', personB64?.length);
  console.log('[Vertex] productB64 len:', productB64?.length);
  console.log('[Vertex] category:', category);

  const instance = {
    personImage:   { image: { bytesBase64Encoded: personB64 } },
    productImages: [{ image: { bytesBase64Encoded: productB64 } }],
  };

  const body = {
    instances: [instance],
    parameters: {
      sampleCount: 1,
      safetySetting: 'block_few',
      personGeneration: 'allow_all',
    },
  };

  console.log('[Vertex] endpoint:', endpoint);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vertex AI retornou ${response.status}: ${err}`);
  }

  const data = await response.json();
  const imageBase64 = data?.predictions?.[0]?.bytesBase64Encoded;

  if (!imageBase64) {
    throw new Error('Vertex AI não retornou imagem. Resposta: ' + JSON.stringify(data));
  }

  return `data:image/png;base64,${imageBase64}`;
}

// ─── Handler principal ────────────────────────────────────────────────────────

async function processHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }


  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId obrigatório' });
  }

  // Busca os dados do job no Redis (incluindo as imagens)
  const raw = await redis.get(`job:${jobId}`);
  if (!raw) {
    return res.status(404).json({ error: 'Job não encontrado ou expirado' });
  }
  const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const { personImage, garmentImage, category, projectId } = job;

  // Marca como "processing"
  await redis.set(
    `job:${jobId}`,
    JSON.stringify({ status: 'processing', startedAt: Date.now() }),
    { ex: 3600 }
  );

  try {
    const resultImage = await callVertexTryOn({
      projectId,
      personImage,
      garmentImage,
      category,
    });

    // Salva o resultado — o widget vai buscar via /api/result
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({
        status: 'done',
        resultImage,
        completedAt: Date.now(),
      }),
      { ex: 3600 }
    );

    return res.status(200).json({ jobId, status: 'done' });

  } catch (err) {
    console.error(`[process] Erro no job ${jobId}:`, err);

    // Salva o erro para o widget exibir mensagem adequada
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({
        status: 'error',
        error: err.message,
        failedAt: Date.now(),
      }),
      { ex: 3600 }
    );

    // Retorna 200 para o QStash não fazer retry desnecessário em erros de negócio
    // (erros de infraestrutura lançam exceção e o QStash vai retenttar automaticamente)
    return res.status(200).json({ jobId, status: 'error', error: err.message });
  }
}

export default processHandler;
