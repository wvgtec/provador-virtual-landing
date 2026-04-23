/**
 * Provador Virtual — Widget
 * Versão: 2.0 (modelo assíncrono com polling)
 *
 * Como usar:
 *   <script src="https://cdn.jsdelivr.net/gh/SEU-USER/SEU-REPO@v2.0/widget/tryon-widget.js" defer></script>
 *
 * O script lê window.VTON_API_URL ou o atributo data-api do elemento de produto.
 */

(function () {
  'use strict';

  // ─── Configuração ─────────────────────────────────────────────────────────

  const API_URL    = window.VTON_API_URL || '';
  const CLIENT_KEY = window.VTON_CLIENT_KEY || '';
  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS  = 90000;

  if (!API_URL) {
    console.warn('[Provador Virtual] window.VTON_API_URL não definido.');
    return;
  }
  if (!CLIENT_KEY) {
    console.warn('[Provador Virtual] window.VTON_CLIENT_KEY não definido.');
  }

  // ─── Estilos ──────────────────────────────────────────────────────────────

  const CSS = `
    #nksw-overlay {
      display: none; position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.6); align-items: center; justify-content: center;
    }
    #nksw-overlay.active { display: flex; }
    #nksw-modal {
      background: #fff; border-radius: 16px; width: 92%; max-width: 520px;
      max-height: 92vh; overflow-y: auto; padding: 28px 24px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.18); position: relative;
    }
    #nksw-close {
      position: absolute; top: 16px; right: 16px;
      background: none; border: none; font-size: 22px; cursor: pointer;
      color: #666; line-height: 1;
    }
    #nksw-title { font-size: 16px; font-weight: 700; margin: 0 0 4px; color: #1a1a1a; letter-spacing: .05em; display: flex; align-items: center; }
    #nksw-subtitle { font-size: 13px; color: #888; margin: 0 0 16px; }

    /* Upload */
    #nksw-upload-area {
      border: 2px dashed #d0d0d0; border-radius: 16px; padding: 40px 16px;
      text-align: center; cursor: pointer; transition: border-color .2s, background .2s;
      background: #fafafa;
    }
    #nksw-upload-area:hover { border-color: #1a1a1a; background: #f5f5f5; }
    #nksw-upload-area input { display: none; }
    #nksw-upload-icon { font-size: 40px; margin-bottom: 12px; }
    #nksw-upload-label { font-size: 15px; font-weight: 600; color: #1a1a1a; }
    #nksw-upload-hint { font-size: 12px; color: #999; margin-top: 6px; line-height: 1.6; }
    #nksw-privacy { font-size: 11px; color: #aaa; text-align: center; margin-top: 10px; line-height: 1.5; }
    #nksw-preview-img {
      max-width: 100%; max-height: 200px; border-radius: 12px;
      margin: 12px auto 0; display: block;
    }

    /* Botão principal */
    #nksw-btn-try {
      width: 100%; padding: 16px; background: #1a1a1a; color: #fff;
      border: none; border-radius: 50px; font-size: 13px; font-weight: 700;
      letter-spacing: .08em; text-transform: uppercase;
      cursor: pointer; margin-top: 16px; transition: background .2s;
      font-family: inherit;
    }
    #nksw-btn-try:hover { background: #333; }
    #nksw-btn-try:disabled { background: #ccc; cursor: not-allowed; }

    /* Status / loading */
    #nksw-status {
      display: none; text-align: center; padding: 20px 0;
    }
    #nksw-spinner {
      width: 40px; height: 40px; border: 4px solid #eee;
      border-top-color: #6C5CE7; border-radius: 50%;
      animation: nksw-spin 0.8s linear infinite; margin: 0 auto 12px;
    }
    @keyframes nksw-spin { to { transform: rotate(360deg); } }
    #nksw-status-text { font-size: 14px; color: #555; }
    #nksw-progress-bar-wrap {
      height: 4px; background: #eee; border-radius: 2px; margin-top: 12px; overflow: hidden;
    }
    #nksw-progress-bar {
      height: 100%; background: #6C5CE7; width: 0%;
      transition: width 1s ease; border-radius: 2px;
    }

    /* Resultado */
    #nksw-result { display: none; text-align: center; }
    #nksw-result-img {
      max-width: 100%; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    }
    #nksw-result-actions { display: flex; gap: 10px; margin-top: 14px; }
    #nksw-btn-save, #nksw-btn-retry {
      flex: 1; padding: 12px; border-radius: 8px;
      font-size: 14px; font-weight: 600; cursor: pointer; border: none;
    }
    #nksw-btn-save { background: #6C5CE7; color: #fff; }
    #nksw-btn-retry { background: #f0f0f0; color: #333; }

    /* Lead form */
    #nksw-lead { margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; }
    #nksw-lead-title { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
    #nksw-lead-sub { font-size: 13px; color: #666; margin: 0 0 14px; }
    #nksw-lead input {
      width: 100%; padding: 10px 12px; border: 1.5px solid #e0e0e0;
      border-radius: 8px; font-size: 14px; margin-bottom: 10px;
      box-sizing: border-box; outline: none; transition: border-color .2s;
    }
    #nksw-lead input:focus { border-color: #6C5CE7; }
    #nksw-lead-submit {
      width: 100%; padding: 12px; background: #1a1a1a; color: #fff;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer;
    }
    #nksw-lead-sent { text-align: center; font-size: 13px; color: #6C5CE7; padding: 8px 0; }

    /* Botão trigger */
    .nksw-trigger-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 15px 24px;
      background: #fff; color: #1a1a1a;
      border: 2px solid #1a1a1a; border-radius: 50px;
      font-size: 14px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; cursor: pointer;
      transition: all .2s; margin-top: 12px;
      font-family: inherit;
    }
    .nksw-trigger-btn:hover { background: #1a1a1a; color: #fff; }
    .nksw-trigger-btn svg { flex-shrink: 0; }

    /* Erro */
    #nksw-error {
      display: none; background: #fff3f3; border: 1px solid #ffcccc;
      border-radius: 8px; padding: 14px 16px; color: #c0392b;
      font-size: 13px; margin-top: 12px; text-align: center;
    }
  `;

  // ─── HTML do modal ─────────────────────────────────────────────────────────

  const MODAL_HTML = `
    <div id="nksw-overlay">
      <div id="nksw-modal" role="dialog" aria-modal="true" aria-labelledby="nksw-title">
        <button id="nksw-close" aria-label="Fechar">&times;</button>

        <h2 id="nksw-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:8px"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          PROVADOR VIRTUAL
        </h2>
        <p id="nksw-subtitle">Clique ou arraste sua foto aqui</p>

        <!-- Upload -->
        <div id="nksw-upload-area" role="button" tabindex="0" aria-label="Selecionar foto">
          <input type="file" id="nksw-file" accept="image/*">
          <div id="nksw-upload-icon">📷</div>
          <div id="nksw-upload-label">Clique ou arraste sua foto aqui</div>
          <div id="nksw-upload-hint">JPG, PNG ou WEBP &bull; foto de corpo inteiro &bull; boa iluminação</div>
        </div>
        <img id="nksw-preview-img" alt="Prévia da sua foto" style="display:none">

        <button type="button" id="nksw-btn-try" disabled>EXPERIMENTAR VIRTUALMENTE</button>
        <p id="nksw-privacy">🔒 Sua foto é processada em tempo real e não é armazenada em nenhum servidor.</p>

        <!-- Status / loading -->
        <div id="nksw-status">
          <div id="nksw-spinner"></div>
          <div id="nksw-status-text">Preparando...</div>
          <div id="nksw-progress-bar-wrap">
            <div id="nksw-progress-bar"></div>
          </div>
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

        <!-- Captura de lead -->
        <div id="nksw-lead" style="display:none">
          <div id="nksw-lead-title">🌊 Gostou do resultado?</div>
          <div id="nksw-lead-sub">Cadastre seu e-mail e receba novidades em primeira mão.</div>
          <input type="text" id="nksw-lead-name" placeholder="Seu nome" autocomplete="name">
          <input type="email" id="nksw-lead-email" placeholder="Seu e-mail" autocomplete="email">
          <button id="nksw-lead-submit">Quero receber novidades</button>
          <div id="nksw-lead-sent" style="display:none">✓ Cadastro feito! Obrigado.</div>
        </div>
      </div>
    </div>
  `;

  // ─── Inicialização ────────────────────────────────────────────────────────

  function init() {
    // Injeta CSS
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Injeta modal
    const wrapper = document.createElement('div');
    wrapper.innerHTML = MODAL_HTML;
    document.body.appendChild(wrapper);

    // Se existir um elemento âncora (#vton-anchor), injeta o botão dentro dele
    // Caso contrário, usa os botões que o lojista colocou manualmente (data-vton ou .nksw-trigger-btn)
    const anchor = document.getElementById('vton-anchor');
    if (anchor) {
      const btn = document.createElement('button');
      btn.type = 'button'; // evita submit do form no Shopify/WooCommerce
      btn.className = 'nksw-trigger-btn';
      btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg> Experimentar virtualmente`;
      anchor.appendChild(btn);
      btn.addEventListener('click', openModal);
    } else {
      // Botões trigger — adiciona listener em todos os elementos com data-vton
      document.querySelectorAll('[data-vton]').forEach(bindTrigger);
      // Botão trigger gerado pelo snippet (classe padrão)
      document.querySelectorAll('.nksw-trigger-btn').forEach(bindTrigger);
    }

    bindModal();
  }

  function bindTrigger(el) {
    el.addEventListener('click', openModal);
  }

  // ─── Lógica do modal ──────────────────────────────────────────────────────

  let currentJobId  = null;
  let pollTimer     = null;
  let pollStartTime = null;
  let progressTimer = null;
  let personBase64  = null;
  let garmentUrl    = null;
  let category      = 'auto';

  function openModal() {
    // Prioridade 1: variável global injetada pelo snippet da plataforma
    // Prioridade 2: atributo data-vton-image em qualquer elemento
    // Prioridade 3: seletores específicos por plataforma (fallback)
    garmentUrl = window.VTON_GARMENT_URL
      || document.querySelector('[data-vton-image]')?.dataset?.vtonImage
      || document.querySelector('.product__media img')?.src           // Shopify
      || document.querySelector('.product-featured-img')?.src         // Shopify legacy
      || document.querySelector('.js-product-featured-image')?.src    // Nuvemshop
      || document.querySelector('.woocommerce-product-gallery__image img')?.src // WooCommerce
      || document.querySelector('.product-image img')?.src            // Loja Integrada
      || document.querySelector('[class*="productImageTag"]')?.src    // VTEX IO
      || document.querySelector('[class*="product-image"] img')?.src  // VTEX IO alternativo
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
    currentJobId = null;
    clearPolling();
    show('nksw-upload-area');
    hide('nksw-status');
    hide('nksw-result');
    hide('nksw-error');
    hide('nksw-lead');
    hide('nksw-preview-img');
    document.getElementById('nksw-btn-try').disabled = true;
    document.getElementById('nksw-file').value = '';
    document.getElementById('nksw-progress-bar').style.width = '0%';
  }

  function bindModal() {
    const overlay = document.getElementById('nksw-overlay');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.getElementById('nksw-close').addEventListener('click', closeModal);

    // Upload por clique ou teclado
    const uploadArea = document.getElementById('nksw-upload-area');
    uploadArea.addEventListener('click', () => document.getElementById('nksw-file').click());
    uploadArea.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('nksw-file').click(); });

    document.getElementById('nksw-file').addEventListener('change', handleFileSelect);
    document.getElementById('nksw-btn-try').addEventListener('click', startTryOn);
    document.getElementById('nksw-btn-retry').addEventListener('click', resetModal);
    document.getElementById('nksw-btn-save').addEventListener('click', savePhoto);
    document.getElementById('nksw-lead-submit').addEventListener('click', submitLead);
  }

  // ─── Upload e redimensionamento ───────────────────────────────────────────

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;

    resizeImage(file, 1024, (base64) => {
      personBase64 = base64;

      const preview = document.getElementById('nksw-preview-img');
      preview.src = base64;
      preview.style.display = 'block';

      document.getElementById('nksw-upload-icon').style.display = 'none';
      document.getElementById('nksw-upload-label').textContent = file.name;
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
          else { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ─── Try-on assíncrono ────────────────────────────────────────────────────

  async function startTryOn() {
    if (!personBase64) return;

    hide('nksw-upload-area');
    hide('nksw-preview-img');
    hide('nksw-error');
    show('nksw-status');
    setStatusText('Enviando imagem...');
    animateProgress(0, 15, 3000);

    try {
      const res = await fetch(`${API_URL}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personImage: personBase64,
          garmentImage: garmentUrl,
          category,
          clientKey: CLIENT_KEY,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.jobId) {
        throw new Error(data.error || 'Erro ao iniciar o processamento');
      }

      currentJobId = data.jobId;
      setStatusText('Processando com IA...');
      animateProgress(15, 85, 30000);
      startPolling(currentJobId);

    } catch (err) {
      showError('Não foi possível conectar. Tente novamente em instantes.');
      console.error('[Provador Virtual] Erro no submit:', err);
    }
  }

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

      if (data.status === 'done') {
        clearPolling();
        animateProgress(85, 100, 500);
        setTimeout(() => showResult(data.resultImage), 600);

      } else if (data.status === 'error') {
        clearPolling();
        showError('A IA não conseguiu processar a imagem. Tente com outra foto.');

      } else if (data.status === 'processing') {
        setStatusText('A IA está trabalhando...');
      }
      // status "pending" → continua aguardando

    } catch (_) {
      // Falha de rede temporária — continua o polling silenciosamente
    }
  }

  function clearPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  // ─── Progresso visual ─────────────────────────────────────────────────────

  function animateProgress(from, to, durationMs) {
    const bar   = document.getElementById('nksw-progress-bar');
    const steps = 30;
    const step  = (to - from) / steps;
    let current = from;
    let count   = 0;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      current += step;
      count++;
      bar.style.width = Math.min(current, to) + '%';
      if (count >= steps) clearInterval(progressTimer);
    }, durationMs / steps);
  }

  // ─── Exibição do resultado ────────────────────────────────────────────────

  function showResult(imageDataUrl) {
    hide('nksw-status');
    const img = document.getElementById('nksw-result-img');
    img.src = imageDataUrl;
    show('nksw-result');
    show('nksw-lead');
  }

  function savePhoto() {
    const img = document.getElementById('nksw-result-img');
    if (!img.src) return;
    const a = document.createElement('a');
    a.href = img.src;
    a.download = 'meu-look-provador-virtual.jpg';
    a.click();
  }

  // ─── Lead ─────────────────────────────────────────────────────────────────

  async function submitLead() {
    const name  = document.getElementById('nksw-lead-name').value.trim();
    const email = document.getElementById('nksw-lead-email').value.trim();

    if (!email || !email.includes('@')) {
      document.getElementById('nksw-lead-email').style.borderColor = '#e74c3c';
      return;
    }

    try {
      await fetch(`${API_URL}/api/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
    } catch (_) { /* falha silenciosa — lead não bloqueia a experiência */ }

    hide('nksw-lead-name');
    hide('nksw-lead-email');
    hide('nksw-lead-submit');
    show('nksw-lead-sent');
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

  function setStatusText(text) {
    const el = document.getElementById('nksw-status-text');
    if (el) el.textContent = text;
  }

  function showError(msg) {
    hide('nksw-status');
    show('nksw-upload-area');
    const errEl = document.getElementById('nksw-error');
    errEl.textContent = msg;
    errEl.style.display = 'block';
    document.getElementById('nksw-btn-try').disabled = false;
  }

  // ─── Aguarda DOM e inicializa ─────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
