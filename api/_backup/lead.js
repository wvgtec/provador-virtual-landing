// api/lead.js
// Salva o lead capturado pelo widget nos Clientes do Shopify.
// Chamado pelo widget depois que o usuário preenche nome + email.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'email é obrigatório' });
  }

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!store || !token) {
    return res.status(500).json({ error: 'Credenciais Shopify não configuradas' });
  }

  try {
    // Verifica se o cliente já existe pelo e-mail
    const searchRes = await fetch(
      `https://${store}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const searchData = await searchRes.json();
    const existing = searchData?.customers?.[0];

    if (existing) {
      // Apenas adiciona a tag se o cliente já existe — não cria duplicata
      const tags = existing.tags
        ? [...new Set([...existing.tags.split(', '), 'newsletter', 'provador-virtual'])].join(', ')
        : 'newsletter, provador-virtual';

      await fetch(`https://${store}/admin/api/2024-01/customers/${existing.id}.json`, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customer: { id: existing.id, tags } }),
      });

      return res.status(200).json({ status: 'updated', customerId: existing.id });
    }

    // Cria novo cliente
    const nameParts = (name || '').trim().split(' ');
    const createRes = await fetch(`https://${store}/admin/api/2024-01/customers.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: {
          first_name: nameParts[0] || '',
          last_name: nameParts.slice(1).join(' ') || '',
          email,
          phone: phone || null,
          tags: 'newsletter, provador-virtual',
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
          },
        },
      }),
    });

    const createData = await createRes.json();

    if (!createRes.ok) {
      throw new Error(JSON.stringify(createData.errors));
    }

    return res.status(201).json({
      status: 'created',
      customerId: createData.customer.id,
    });

  } catch (err) {
    console.error('[lead] Erro:', err);
    return res.status(500).json({ error: 'Erro ao salvar lead', detail: err.message });
  }
}
