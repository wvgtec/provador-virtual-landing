// api/submit.js
// Recebe a requisição do widget, salva as imagens no Redis e envia só o jobId para a fila.
// O processamento real (Vertex AI) acontece em api/process.js chamado pelo QStash.

import { Redis } from '@upstash/redis';
import { Client as QStashClient } from '@upstash/qstash';
import { randomUUID } from 'crypto';

const PROJECT_ID = 'provador-virtual-494213';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { personImage, garmentImage, category, clientKey } = req.body;

    if (!personImage || !garmentImage) {
      return res.status(400).json({ error: 'personImage e garmentImage são obrigatórios' });
    }

    // Valida a chave do cliente (exceto demo sem chave)
    if (clientKey) {
      const raw = await redis.get(`client:${clientKey}`);
      if (!raw) {
        return res.status(403).json({ error: 'Chave de cliente inválida.' });
      }
      const client = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!client.active) {
        return res.status(403).json({ error: 'Acesso suspenso. Entre em contato com o suporte.' });
      }
      // Incrementa o contador de uso
      client.usageCount = (client.usageCount || 0) + 1;
      await redis.set(`client:${clientKey}`, JSON.stringify(client));
    }

    const jobId = randomUUID();

    // Salva as imagens no Redis — o QStash tem limite de 1MB por mensagem,
    // então as imagens ficam aqui e o process.js as busca pelo jobId
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({
        status: 'pending',
        createdAt: Date.now(),
        projectId: PROJECT_ID,
        personImage,
        garmentImage,
        category: category || 'auto',
        clientKey: clientKey || null,
      }),
      { ex: 3600 }
    );

    // Envia só o jobId para a fila — mensagem pequena, sem imagens
    const callbackUrl = `${process.env.APP_URL}/api/process`;

    await qstash.publishJSON({
      url: callbackUrl,
      body: { jobId },
      retries: 3,
    });

    return res.status(202).json({
      jobId,
      status: 'pending',
      message: 'Job criado. Use /api/result?jobId=' + jobId + ' para acompanhar.',
    });

  } catch (err) {
    console.error('[submit] Erro:', err);
    return res.status(500).json({ error: 'Erro interno ao criar job', detail: err.message });
  }
}
