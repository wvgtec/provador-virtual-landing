/**
 * Mirage — Widget de Provador Virtual
 * Versão: 5.0
 *
 * Configuração (defina antes de carregar o script):
 *
 *   window.VTON_API_URL          = 'https://...';           // obrigatório
 *   window.VTON_CLIENT_KEY       = 'pvk_...';               // obrigatório
 *   window.VTON_GARMENT_URL      = '{{ image_url }}';       // URL da peça
 *   window.VTON_GARMENT_CATEGORY = 'tops';                  // tops | bottoms | one-pieces | auto
 *   window.VTON_STORE_NAME       = 'Sua Loja';              // nome da loja para o formulário de lead
 *
 *   // Personalização do botão trigger:
 *   window.VTON_BTN_TEXT         = 'Experimentar';
 *   window.VTON_BTN_BG           = '#1a1a1a';
 *   window.VTON_BTN_COLOR        = '#ffffff';
 *   window.VTON_BTN_WIDTH        = '100%';
 *   window.VTON_BTN_HEIGHT       = '52px';
 *   window.VTON_BTN_RADIUS       = '50px';
 */

(function () {
  'use strict';

  // ─── Configuração ─────────────────────────────────────────────────────────

  const API_URL    = window.VTON_API_URL    || '';
  const CLIENT_KEY = window.VTON_CLIENT_KEY || '';
  const STORE_NAME = window.VTON_STORE_NAME || '';

  const BTN_TEXT   = window.VTON_BTN_TEXT   || 'Experimentar virtualmente';
  const BTN_BG     = window.VTON_BTN_BG     || '#1a1a1a';
  const BTN_COLOR  = window.VTON_BTN_COLOR  || '#ffffff';
  const BTN_WIDTH  = window.VTON_BTN_WIDTH  || '100%';
  const BTN_HEIGHT = window.VTON_BTN_HEIGHT || '52px';
  const BTN_RADIUS = window.VTON_BTN_RADIUS || '50px';

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS  = 90000;

  if (!API_URL) {
    console.warn('[Mirage] window.VTON_API_URL não definido.');
    return;
  }

  // ─── Estilos ──────────────────────────────────────────────────────────────

  const CSS = `
    #nksw-overlay {
      display: none; position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.6); align-items: center; justify-content: center;
    }
    #nksw-overlay.active { display: flex; }
    #nksw-modal {
      background: #fff; border-radius: 16px; width: 92%; max-width: 480px;
      max-height: 92vh; overflow-y: auto; padding: 24px 20px 28px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18); position: relative;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #nksw-close {
      position: absolute; top: 14px; right: 14px;
      background: none; border: none; font-size: 22px; cursor: pointer;
      color: #aaa; line-height: 1; padding: 4px;
    }
    #nksw-close:hover { color: #333; }

    /* Cabeçalho */
    #nksw-header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
    #nksw-logo-icon {
      width: 34px; height: 34px; border-radius: 8px; background: #1a1a1a;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    #nksw-title {
      font-size: 13px; font-weight: 700; color: #1a1a1a;
      letter-spacing: .07em; text-transform: uppercase; margin: 0;
    }

    /* Upload */
    #nksw-upload-wrap { margin-bottom: 14px; }
    #nksw-upload-area {
      border: 2px dashed #d0d0d0; border-radius: 14px; padding: 36px 16px;
      text-align: center; cursor: pointer; transition: border-color .2s, background .2s;
      background: #fafafa;
    }
    #nksw-upload-area:hover { border-color: #1a1a1a; background: #f5f5f5; }
    #nksw-upload-area input { display: none; }
    #nksw-upload-icon { font-size: 36px; margin-bottom: 10px; }
    #nksw-upload-label { font-size: 14px; font-weight: 600; color: #1a1a1a; }
    #nksw-upload-hint { font-size: 12px; color: #999; margin-top: 6px; line-height: 1.5; }
    #nksw-preview-img {
      width: 100%; max-height: 220px; object-fit: cover;
      border-radius: 12px; display: none; margin-bottom: 10px;
    }

    /* Botão principal */
    #nksw-btn-try {
      width: 100%; padding: 16px; background: #1a1a1a; color: #fff;
      border: none; border-radius: 50px; font-size: 13px; font-weight: 700;
      letter-spacing: .08em; text-transform: uppercase;
      cursor: pointer; transition: background .2s; font-family: inherit;
    }
    #nksw-btn-try:hover:not(:disabled) { background: #333; }
    #nksw-btn-try:disabled { background: #c8c8c8; cursor: not-allowed; }

    /* Loading */
    #nksw-loading { display: none; padding: 28px 0 8px; text-align: center; }
    #nksw-spinner {
      width: 56px; height: 56px; border: 4px solid #eee;
      border-top-color: #6C5CE7; border-radius: 50%;
      animation: nksw-spin 0.8s linear infinite; margin: 0 auto 16px;
    }
    @keyframes nksw-spin { to { transform: rotate(360deg); } }
    #nksw-loading-title { font-size: 16px; font-weight: 700; color: #1a1a1a; }
    #nksw-loading-sub { font-size: 13px; color: #999; margin-top: 6px; }
    #nksw-progress-wrap {
      height: 4px; background: #eee; border-radius: 2px; margin-top: 18px; overflow: hidden;
    }
    #nksw-progress-bar {
      height: 100%; background: #6C5CE7; width: 0%; transition: width 1s ease;
    }

    /* Divider */
    #nksw-divider {
      display: none; height: 1px; background: #eee; margin: 20px 0;
    }

    /* Lead post-click */
    #nksw-lead-post { display: none; }
    #nksw-lead-post-title {
      font-size: 14px; font-weight: 700; color: #1a1a1a; margin: 0 0 4px;
    }
    #nksw-lead-post-title span { font-size: 18px; margin-right: 6px; }
    #nksw-lead-post-sub {
      font-size: 13px; color: #888; margin: 0 0 14px; line-height: 1.5;
    }
    .nksw-field {
      width: 100%; padding: 12px 14px; margin-bottom: 10px;
      border: 1.5px solid #e0e0e0; border-radius: 10px;
      font-size: 14px; font-family: inherit; color: #1a1a1a;
      background: #fff; outline: none; box-sizing: border-box;
      transition: border-color .15s;
    }
    .nksw-field:focus { border-color: #1a1a1a; }
    .nksw-field::placeholder { color: #bbb; }
    #nksw-btn-lead {
      width: 100%; padding: 14px; background: #1a1a1a; color: #fff;
      border: none; border-radius: 50px; font-size: 14px; font-weight: 700;
      cursor: pointer; transition: background .2s; font-family: inherit;
      margin-bottom: 10px;
    }
    #nksw-btn-lead:hover { background: #333; }
    #nksw-btn-skip {
      display: block; text-align: center; font-size: 13px; color: #aaa;
      background: none; border: none; cursor: pointer; font-family: inherit;
      width: 100%; padding: 4px; transition: color .15s;
    }
    #nksw-btn-skip:hover { color: #666; }
    #nksw-lead-success {
      display: none; text-align: center; padding: 10px 0 4px;
      font-size: 13px; color: #00b894; font-weight: 600;
    }

    /* Resultado */
    #nksw-result { display: none; margin-bottom: 12px; }
    #nksw-result-img {
      width: 100%; border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.1);
    }
    #nksw-result-actions {
      display: flex; gap: 10px; margin-top: 12px;
    }
    #nksw-btn-save, #nksw-btn-retry {
      flex: 1; padding: 12px; border-radius: 8px;
      font-size: 13px; font-weight: 600; cursor: pointer; border: none;
      font-family: inherit;
    }
    #nksw-btn-save  { background: #6C5CE7; color: #fff; }
    #nksw-btn-retry { background: #f0f0f0; color: #333; }

    /* Erro */
    #nksw-error {
      display: none; background: #fff3f3; border: 1px solid #ffcccc;
      border-radius: 8px; padding: 12px 14px; color: #c0392b;
      font-size: 13px; margin-top: 12px; text-align: center;
    }

    /* Privacy */
    #nksw-privacy {
      font-size: 11px; color: #bbb; text-align: center;
      margin-top: 14px; line-height: 1.5;
    }

    /* Trigger */
    .nksw-trigger-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 0 24px; border: 2px solid currentColor; border-radius: 50px;
      font-size: 14px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      cursor: pointer; transition: opacity .2s; margin-top: 12px;
      font-family: inherit; box-sizing: border-box;
    }
    .nksw-trigger-btn:hover { opacity: .85; }
    .nksw-trigger-btn svg { flex-shrink: 0; }
  `;

  // ─── HTML do modal ─────────────────────────────────────────────────────────

  const storeText = STORE_NAME
    ? `Cadastre-se e receba as novidades da ${STORE_NAME} em primeira mão!`
    : 'Cadastre-se para receber novidades e promoções em primeira mão!';

  const MODAL_HTML = `
    <div id="nksw-overlay">
      <div id="nksw-modal" role="dialog" aria-modal="true" aria-labelledby="nksw-title">
        <button id="nksw-close" aria-label="Fechar">&times;</button>

        <div id="nksw-header">
          <div id="nksw-logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </div>
          <h2 id="nksw-title">PROVADOR VIRTUAL</h2>
        </div>

        <!-- Upload -->
        <div id="nksw-upload-wrap">
          <img id="nksw-preview-img" alt="Prévia da sua foto">
          <div id="nksw-upload-area" role="button" tabindex="0" aria-label="Selecionar foto">
            <input type="file" id="nksw-file" accept="image/*">
            <div id="nksw-upload-icon">📷</div>
            <div id="nksw-upload-label">Clique ou arraste sua foto aqui</div>
            <div id="nksw-upload-hint">Foto de corpo inteiro · boa iluminação · JPG ou PNG</div>
          </div>
        </div>

        <button type="button" id="nksw-btn-try" disabled>EXPERIMENTAR VIRTUALMENTE</button>

        <!-- Loading -->
        <div id="nksw-loading">
          <div id="nksw-spinner"></div>
          <div id="nksw-loading-title">Gerando seu look...</div>
          <div id="nksw-loading-sub">Aguarde alguns segundos</div>
          <div id="nksw-progress-wrap"><div id="nksw-progress-bar"></div></div>
        </div>

        <!-- Divider -->
        <div id="nksw-divider"></div>

        <!-- Lead form (aparece durante e após o loading) -->
        <div id="nksw-lead-post">
          <p id="nksw-lead-post-title"><span>🛍️</span>Gostou do resultado?</p>
          <p id="nksw-lead-post-sub">${storeText}</p>
          <input class="nksw-field" type="text"  id="nksw-lead-name"     placeholder="Seu nome">
          <input class="nksw-field" type="tel"   id="nksw-lead-whatsapp" placeholder="WhatsApp">
          <input class="nksw-field" type="email" id="nksw-lead-email"    placeholder="Seu e-mail">
          <button type="button" id="nksw-btn-lead">Quero receber novidades</button>
          <button type="button" id="nksw-btn-skip">Pular</button>
          <div id="nksw-lead-success">✓ Cadastro realizado!</div>
        </div>

        <!-- Erro -->
        <div id="nksw-error"></div>

        <!-- Resultado -->
        <div id="nksw-result">
          <img id="nksw-result-img" alt="Resultado do provador virtual">
          <div id="nksw-result-actions">
            <button id="nksw-btn-save">💾 Salvar foto</button>
            <button id="nksw-btn-retry">Tentar novamente</button>
          </div>
        </div>

        <p id="nksw-privacy">🔒 Sua foto é processada em tempo real e não é armazenada em nenhum servidor.</p>
      </div>
    </div>
  `;

  // ─── Inicialização ────────────────────────────────────────────────────────

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = MODAL_HTML;
    document.body.appendChild(wrapper);

    const anchor = document.getElementById('vton-anchor');
    if (anchor) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nksw-trigger-btn';
      btn.style.cssText = [
        `background:${BTN_BG}`, `color:${BTN_COLOR}`,
        `width:${BTN_WIDTH}`, `height:${BTN_HEIGHT}`,
        `border-radius:${BTN_RADIUS}`, `border-color:${BTN_BG}`,
      ].join(';');
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> ${BTN_TEXT}`;
      anchor.appendChild(btn);
      btn.addEventListener('click', openModal);
    } else {
      document.querySelectorAll('[data-vton], .nksw-trigger-btn').forEach(el => el.addEventListener('click', openModal));
    }

    bindModal();
  }

  // ─── Estado ───────────────────────────────────────────────────────────────

  let currentJobId  = null;
  let pollTimer     = null;
  let pollStartTime = null;
  let progressTimer = null;
  let personBase64  = null;
  let personGcsUrl  = null;
  let garmentUrl    = null;
  let category      = 'auto';

  function openModal() {
    garmentUrl = window.VTON_GARMENT_URL
      || document.querySelector('[data-vton-image]')?.dataset?.vtonImage
      || document.querySelector('.product__media img')?.src
      || document.querySelector('.product-featured-img')?.src
      || document.querySelector('.js-product-featured-image')?.src
      || document.querySelector('.woocommerce-product-gallery__image img')?.src
      || document.querySelector('.product-image img')?.src
      || document.querySelector('[class*="productImageTag"]')?.src
      || document.querySelector('[class*="product-image"] img')?.src
      || '';

    category = window.VTON_GARMENT_CATEGORY
      || document.querySelector('[data-vton-category]')?.dataset?.vtonCategory
      || 'auto';

    resetModal();
    document.getElementById('nksw-overlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    document.getElementById('nksw-overlay').classList.remove('active');
    document.body.style.overflow = '';
    clearPolling();
  }

  function resetModal() {
    personBase64 = null;
    personGcsUrl = null;
    currentJobId = null;
    clearPolling();

    show('nksw-upload-wrap');
    show('nksw-btn-try');
    hide('nksw-loading');
    hide('nksw-divider');
    hide('nksw-lead-post');
    hide('nksw-result');
    hide('nksw-error');
    hide('nksw-lead-success');
    show('nksw-privacy');

    const preview = document.getElementById('nksw-preview-img');
    preview.style.display = 'none';
    preview.src = '';

    const uploadArea = document.getElementById('nksw-upload-area');
    uploadArea.style.display = '';

    document.getElementById('nksw-upload-icon').style.display = '';
    document.getElementById('nksw-upload-label').textContent = 'Clique ou arraste sua foto aqui';
    document.getElementById('nksw-btn-try').disabled = true;
    document.getElementById('nksw-file').value = '';
    document.getElementById('nksw-lead-name').value     = '';
    document.getElementById('nksw-lead-email').value    = '';
    document.getElementById('nksw-lead-whatsapp').value = '';
    document.getElementById('nksw-progress-bar').style.width = '0%';
  }

  function bindModal() {
    const overlay = document.getElementById('nksw-overlay');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById('nksw-close').addEventListener('click', closeModal);

    const uploadArea = document.getElementById('nksw-upload-area');
    uploadArea.addEventListener('click', () => document.getElementById('nksw-file').click());
    uploadArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') document.getElementById('nksw-file').click();
    });

    // Drag & drop
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#1a1a1a'; });
    uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = '#d0d0d0'; });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = '#d0d0d0';
      const f = e.dataTransfer.files?.[0];
      if (f) processFile(f);
    });

    document.getElementById('nksw-file').addEventListener('change', handleFileSelect);
    document.getElementById('nksw-btn-try').addEventListener('click', startTryOn);
    document.getElementById('nksw-btn-retry').addEventListener('click', resetModal);
    document.getElementById('nksw-btn-save').addEventListener('click', savePhoto);
    document.getElementById('nksw-btn-lead').addEventListener('click', submitLead);
    document.getElementById('nksw-btn-skip').addEventListener('click', () => hide('nksw-lead-post'));
  }

  // ─── Upload e redimensionamento ───────────────────────────────────────────

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    processFile(file);
  }

  function processFile(file) {
    resizeImage(file, 1024, (base64) => {
      personBase64 = base64;
      personGcsUrl = null;

      const preview = document.getElementById('nksw-preview-img');
      preview.src = base64;
      preview.style.display = 'block';

      document.getElementById('nksw-upload-area').style.display = 'none';
      document.getElementById('nksw-btn-try').disabled = false;
    });
  }

  function resizeImage(file, maxSize, cb) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
          else       { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  function dataURItoBlob(dataURI) {
    const [header, data] = dataURI.split(',');
    const mime   = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
    const binary = atob(data);
    const array  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
    return new Blob([array], { type: mime });
  }

  // ─── Try-on ───────────────────────────────────────────────────────────────

  async function startTryOn() {
    if (!personBase64) return;

    // Esconde upload, mostra loading + formulário de lead imediatamente
    hide('nksw-upload-wrap');
    hide('nksw-btn-try');
    hide('nksw-error');
    show('nksw-loading');
    show('nksw-divider');
    show('nksw-lead-post');
    hide('nksw-lead-success');

    setLoadingText('Gerando seu look...', 'Aguarde alguns segundos');
    animateProgress(0, 15, 2000);

    try {
      // 1. URL assinada para upload
      const urlRes = await fetch(`${API_URL}/api/upload-url`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clientKey: CLIENT_KEY, contentType: 'image/jpeg' }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok) throw new Error(urlData.error || 'Erro ao gerar URL de upload.');

      animateProgress(15, 35, 3000);

      // 2. Upload direto para GCS
      const blob = dataURItoBlob(personBase64);
      const putRes = await fetch(urlData.signedUrl, {
        method:  'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body:    blob,
      });
      if (!putRes.ok) throw new Error('Falha no upload da foto. Tente novamente.');
      personGcsUrl = urlData.gcsUrl;

      animateProgress(35, 85, 30000);

      // 3. Submete o job (sem lead — será salvo depois pelo usuário)
      const res = await fetch(`${API_URL}/api/submit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          personImageUrl: personGcsUrl,
          garmentImage:   garmentUrl,
          category,
          clientKey:      CLIENT_KEY,
          productUrl:     garmentUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok)  throw new Error(data.error || 'Erro ao iniciar o processamento.');
      if (!data.jobId) throw new Error(data.error || 'Resposta inesperada da API.');

      currentJobId = data.jobId;
      startPolling(currentJobId);

    } catch (err) {
      showError(err.message || 'Não foi possível conectar. Tente novamente.');
    }
  }

  // ─── Lead post-resultado ──────────────────────────────────────────────────

  async function submitLead() {
    const name     = document.getElementById('nksw-lead-name').value.trim();
    const email    = document.getElementById('nksw-lead-email').value.trim();
    const whatsapp = document.getElementById('nksw-lead-whatsapp').value.trim();

    if (!name || !email || !whatsapp) {
      showLeadError('Preencha todos os campos para continuar.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showLeadError('E-mail inválido.');
      return;
    }
    if (!currentJobId) {
      // Job ainda não terminou — salva localmente para tentar depois
      pendingLead = { name, email, whatsapp };
      show('nksw-lead-success');
      document.getElementById('nksw-lead-success').textContent = '✓ Dados salvos! Aguardando resultado...';
      return;
    }

    await postLead({ name, email, whatsapp });
  }

  let pendingLead = null;

  async function postLead(lead) {
    try {
      await fetch(`${API_URL}/api/save-lead`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jobId: currentJobId, clientKey: CLIENT_KEY, lead }),
      });
    } catch (_) { /* silencioso */ }

    // Oculta form e mostra confirmação
    document.getElementById('nksw-lead-name').style.display     = 'none';
    document.getElementById('nksw-lead-email').style.display    = 'none';
    document.getElementById('nksw-lead-whatsapp').style.display = 'none';
    document.getElementById('nksw-btn-lead').style.display      = 'none';
    document.getElementById('nksw-btn-skip').style.display      = 'none';
    document.getElementById('nksw-lead-success').style.display  = 'block';
    document.getElementById('nksw-lead-success').textContent    = '✓ Cadastro realizado! Obrigado.';
    pendingLead = null;
  }

  function showLeadError(msg) {
    const el = document.getElementById('nksw-error');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  function startPolling(jobId) {
    pollStartTime = Date.now();
    clearPolling();
    pollTimer = setInterval(() => pollResult(jobId), POLL_INTERVAL_MS);
  }

  async function pollResult(jobId) {
    if (Date.now() - pollStartTime > POLL_TIMEOUT_MS) {
      clearPolling();
      showError('O processamento demorou mais que o esperado. Tente novamente.');
      return;
    }
    try {
      const res  = await fetch(`${API_URL}/api/result?jobId=${jobId}`);
      const data = await res.json();

      if (data.status === 'done' || data.status === 'completed') {
        clearPolling();
        animateProgress(85, 100, 500);
        setTimeout(() => showResult(data.output || data.resultImage), 600);
      } else if (data.status === 'error' || data.status === 'failed') {
        clearPolling();
        showError(data.error || 'Não foi possível processar. Tente com outra foto.');
      }
    } catch (_) { /* rede instável — continua */ }
  }

  function clearPolling() {
    if (pollTimer)     { clearInterval(pollTimer);     pollTimer     = null; }
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  // ─── Progresso visual ─────────────────────────────────────────────────────

  function animateProgress(from, to, durationMs) {
    const bar = document.getElementById('nksw-progress-bar');
    const steps = 30;
    const step  = (to - from) / steps;
    let current = from, count = 0;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      current += step; count++;
      bar.style.width = Math.min(current, to) + '%';
      if (count >= steps) clearInterval(progressTimer);
    }, durationMs / steps);
  }

  // ─── Resultado ────────────────────────────────────────────────────────────

  function showResult(imageUrl) {
    hide('nksw-loading');
    document.getElementById('nksw-result-img').src = imageUrl;
    show('nksw-result');

    // Se tinha lead pendente (preenchido durante o loading), envia agora
    if (pendingLead) {
      postLead(pendingLead);
    }
  }

  function savePhoto() {
    const img = document.getElementById('nksw-result-img');
    if (!img.src) return;
    const a = document.createElement('a');
    a.href = img.src; a.download = 'meu-look-mirage.jpg'; a.click();
  }

  // ─── Helpers de UI ───────────────────────────────────────────────────────

  function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }

  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  function setLoadingText(title, sub) {
    const t = document.getElementById('nksw-loading-title');
    const s = document.getElementById('nksw-loading-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
  }

  function showError(msg) {
    clearPolling();
    hide('nksw-loading');
    show('nksw-upload-wrap');
    show('nksw-btn-try');
    document.getElementById('nksw-btn-try').disabled = !personBase64;
    hide('nksw-divider');
    hide('nksw-lead-post');
    const el = document.getElementById('nksw-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  // ─── Inicializa ───────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
