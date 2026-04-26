/**
 * Mirage — Widget de Provador Virtual v6.0
 * Design: NKSW v2 | API: Mirage (GCS upload + save-lead)
 *
 * Configuração global (antes de carregar o script):
 *   window.VTON_API_URL          = 'https://...';
 *   window.VTON_CLIENT_KEY       = 'pvk_...';
 *   window.VTON_GARMENT_URL      = '{{ image_url }}';
 *   window.VTON_GARMENT_CATEGORY = 'auto';
 *   window.VTON_STORE_NAME       = 'Minha Loja';
 *   window.VTON_BTN_TEXT         = 'Experimentar virtualmente';
 *   window.VTON_BTN_BG           = '#111111';
 *   window.VTON_BTN_COLOR        = '#ffffff';
 *   window.VTON_BTN_WIDTH        = '100%';
 *   window.VTON_BTN_HEIGHT       = '52px';
 *   window.VTON_BTN_RADIUS       = '12px';
 */
(function () {
  'use strict';

  const MAX_PX        = 1200;
  const JPEG_QUALITY  = 0.88;
  const POLL_MS       = 2000;
  const POLL_TIMEOUT  = 90000;

  // ─── Configuração ──────────────────────────────────────────────────────────
  const CFG = {
    apiUrl    : (window.VTON_API_URL    || '').replace(/\/$/, ''),
    clientKey : window.VTON_CLIENT_KEY  || '',
    garmentUrl: window.VTON_GARMENT_URL || '',
    category  : window.VTON_GARMENT_CATEGORY || 'auto',
    storeName : window.VTON_STORE_NAME  || '',
    btnText   : window.VTON_BTN_TEXT    || 'Experimentar virtualmente',
    btnBg     : window.VTON_BTN_BG      || '#111111',
    btnColor  : window.VTON_BTN_COLOR   || '#ffffff',
    btnWidth  : window.VTON_BTN_WIDTH   || '100%',
    btnHeight : window.VTON_BTN_HEIGHT  || '52px',
    btnRadius : window.VTON_BTN_RADIUS  || '12px',
  };

  if (!CFG.apiUrl) {
    console.warn('[Mirage] window.VTON_API_URL não definido.');
    return;
  }

  // ─── CSS ───────────────────────────────────────────────────────────────────
  const CSS = `
    .nksw-overlay {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.72);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
      animation: nksw-fade-in 0.2s ease;
    }
    @keyframes nksw-fade-in { from { opacity: 0 } to { opacity: 1 } }
    .nksw-modal {
      background: #fff; border-radius: 16px;
      width: 100%; max-width: 480px; max-height: 90dvh;
      overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.3);
      display: flex; flex-direction: column;
    }
    .nksw-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 24px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .nksw-title { font-family: inherit; font-size: 17px; font-weight: 700; color: #111; margin: 0; }
    .nksw-close {
      background: none; border: none; cursor: pointer;
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: #666; font-size: 20px; transition: background 0.15s;
    }
    .nksw-close:hover { background: #f5f5f5; }
    .nksw-body { padding: 24px; display: flex; flex-direction: column; gap: 20px; }
    .nksw-upload-zone {
      border: 2px dashed #d1d1d1; border-radius: 12px;
      padding: 32px 16px; text-align: center; cursor: pointer;
      transition: border-color 0.2s, background 0.2s; position: relative;
    }
    .nksw-upload-zone:hover, .nksw-upload-zone.drag-over { border-color: #1a1a1a; background: #fafafa; }
    .nksw-upload-zone input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .nksw-upload-icon { font-size: 36px; margin-bottom: 8px; }
    .nksw-upload-text { font-size: 14px; color: #444; margin: 0; line-height: 1.5; }
    .nksw-upload-hint { font-size: 12px; color: #999; margin: 6px 0 0; }
    .nksw-preview-wrap { display: none; flex-direction: column; align-items: center; gap: 10px; }
    .nksw-preview-wrap.visible { display: flex; }
    .nksw-preview-img { width: 100%; max-height: 260px; object-fit: contain; border-radius: 10px; border: 1px solid #eee; background: #f5f5f5; }
    .nksw-change-btn {
      background: none; border: 1px solid #ccc; border-radius: 8px;
      padding: 6px 14px; font-size: 13px; cursor: pointer; color: #555; transition: border-color 0.15s;
    }
    .nksw-change-btn:hover { border-color: #888; }
    .nksw-generate-btn {
      width: 100%; padding: 14px; background: #111; color: #fff;
      border: none; border-radius: 12px; font-size: 15px; font-weight: 700;
      cursor: pointer; transition: background 0.2s, opacity 0.2s; letter-spacing: 1px;
      text-transform: uppercase;
    }
    .nksw-generate-btn:hover:not(:disabled) { background: #333; }
    .nksw-generate-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .nksw-loading { display: none; flex-direction: column; align-items: center; gap: 14px; padding: 8px 0; }
    .nksw-loading.visible { display: flex; }
    .nksw-spinner {
      width: 40px; height: 40px; border: 3px solid #eee;
      border-top-color: #111; border-radius: 50%;
      animation: nksw-spin 0.7s linear infinite;
    }
    @keyframes nksw-spin { to { transform: rotate(360deg) } }
    .nksw-loading-text { font-size: 14px; color: #555; text-align: center; line-height: 1.6; }
    .nksw-progress { width: 100%; height: 4px; background: #eee; border-radius: 2px; overflow: hidden; }
    .nksw-progress-bar { height: 100%; background: #111; border-radius: 2px; transition: width 1.8s ease; width: 0%; }
    .nksw-lead { display: none; flex-direction: column; gap: 10px; }
    .nksw-lead.visible { display: flex; }
    .nksw-lead-inner {
      width: 100%; background: #f9f9f9; border-radius: 12px;
      padding: 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .nksw-lead-title { font-size: 14px; font-weight: 700; color: #111; margin: 0; text-align: center; }
    .nksw-lead-sub   { font-size: 12px; color: #666; margin: 0; text-align: center; line-height: 1.5; }
    .nksw-lead input {
      width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px;
      font-size: 14px; font-family: inherit; box-sizing: border-box; outline: none;
      transition: border-color 0.2s;
    }
    .nksw-lead input:focus { border-color: #111; }
    .nksw-lead-submit {
      width: 100%; padding: 11px; background: #111; color: #fff;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: background 0.2s;
    }
    .nksw-lead-submit:hover { background: #333; }
    .nksw-lead-submit:disabled { opacity: 0.6; cursor: not-allowed; }
    .nksw-lead-skip {
      background: none; border: none; font-size: 12px; color: #aaa;
      cursor: pointer; text-decoration: underline; align-self: center; padding: 0;
    }
    .nksw-lead-skip:hover { color: #666; }
    .nksw-lead-sent { font-size: 13px; color: #2a7a2a; text-align: center; font-weight: 600; margin: 0; display: none; }
    .nksw-result-wrap { display: none; flex-direction: column; gap: 14px; }
    .nksw-result-wrap.visible { display: flex; }
    .nksw-result-img { width: 100%; border-radius: 12px; border: 1px solid #eee; }
    .nksw-result-actions { display: flex; gap: 10px; }
    .nksw-retry-btn {
      flex: 1; padding: 12px; background: none; border: 1.5px solid #111;
      border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s;
    }
    .nksw-retry-btn:hover { background: #f5f5f5; }
    .nksw-save-btn {
      flex: 1; padding: 12px; background: #111; color: #fff;
      border: none; border-radius: 10px; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: background 0.2s;
    }
    .nksw-save-btn:hover { background: #333; }
    .nksw-error {
      display: none; background: #fff3f3; border: 1px solid #ffc0c0;
      border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #c00; text-align: center;
    }
    .nksw-error.visible { display: block; }
    .nksw-disclaimer { font-size: 11px; color: #bbb; text-align: center; line-height: 1.5; padding: 0 8px 4px; }
    .nksw-trigger-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; transition: opacity 0.2s; font-family: inherit;
      border: none; letter-spacing: 0.06em; text-transform: uppercase;
      font-size: 14px; font-weight: 700;
    }
    .nksw-trigger-btn:hover { opacity: 0.85; }
    @media (max-width: 480px) {
      .nksw-modal { max-height: 100dvh; border-radius: 16px 16px 0 0; }
      .nksw-overlay { align-items: flex-end; padding: 0; }
    }
  `;

  function injectStyles() {
    if (document.getElementById('nksw-tryon-styles')) return;
    const s = document.createElement('style');
    s.id = 'nksw-tryon-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ─── Utilitários de imagem ─────────────────────────────────────────────────
  function processImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > MAX_PX || height > MAX_PX) {
          const r = Math.min(MAX_PX / width, MAX_PX / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        if (!dataUrl || dataUrl === 'data:,') return reject(new Error('Falha ao processar imagem'));
        resolve(dataUrl);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
      img.src = url;
    });
  }

  function dataURLtoBlob(dataURL) {
    const [header, data] = dataURL.split(',');
    const mime   = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
    const binary = atob(data);
    const buf    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  function toAbsoluteUrl(url) {
    if (!url) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (!url.startsWith('http')) return 'https://' + url;
    return url;
  }

  // ─── Constrói o modal ──────────────────────────────────────────────────────
  function buildModal(storeName) {
    const leadSub = storeName
      ? `Cadastre-se e receba as novidades da ${storeName} em primeira mão!`
      : 'Cadastre-se para receber novidades e promoções em primeira mão!';

    const overlay = document.createElement('div');
    overlay.className = 'nksw-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Provador Virtual');
    overlay.innerHTML = `
      <div class="nksw-modal">
        <div class="nksw-header">
          <h2 class="nksw-title">👙 Provador Virtual</h2>
          <button class="nksw-close" aria-label="Fechar">&times;</button>
        </div>
        <div class="nksw-body">
          <div class="nksw-upload-zone" id="nksw-drop-zone" tabindex="0" role="button" aria-label="Enviar sua foto">
            <input type="file" id="nksw-file-input" accept="image/jpeg,image/png,image/webp" />
            <div class="nksw-upload-icon">📸</div>
            <p class="nksw-upload-text">Clique ou arraste sua foto aqui</p>
            <p class="nksw-upload-hint">JPG, PNG ou WEBP · foto de corpo inteiro · boa iluminação</p>
          </div>
          <div class="nksw-preview-wrap" id="nksw-preview-wrap">
            <img class="nksw-preview-img" id="nksw-preview-img" alt="Sua foto" />
            <button class="nksw-change-btn" id="nksw-change-btn">Trocar foto</button>
          </div>
          <div class="nksw-error" id="nksw-error"></div>
          <button class="nksw-generate-btn" id="nksw-generate-btn" disabled>
            EXPERIMENTAR VIRTUALMENTE
          </button>
          <div class="nksw-loading" id="nksw-loading">
            <div class="nksw-spinner"></div>
            <p class="nksw-loading-text" id="nksw-loading-text">
              Gerando seu look...<br><small>Aguarde alguns segundos</small>
            </p>
            <div class="nksw-progress">
              <div class="nksw-progress-bar" id="nksw-progress-bar"></div>
            </div>
          </div>
          <div class="nksw-lead" id="nksw-lead">
            <div class="nksw-lead-inner" id="nksw-lead-inner">
              <p class="nksw-lead-title">🛍️ Gostou do resultado?</p>
              <p class="nksw-lead-sub">${leadSub}</p>
              <input id="nksw-lead-name"  type="text"  placeholder="Seu nome"   autocomplete="name" />
              <input id="nksw-lead-phone" type="tel"   placeholder="WhatsApp"   autocomplete="tel" />
              <input id="nksw-lead-email" type="email" placeholder="Seu e-mail" autocomplete="email" />
              <button class="nksw-lead-submit" id="nksw-lead-submit">Quero receber novidades</button>
              <button class="nksw-lead-skip" id="nksw-lead-skip">Pular</button>
            </div>
            <p class="nksw-lead-sent" id="nksw-lead-sent">
              ✅ Cadastro realizado! Fique de olho na sua caixa de entrada.
            </p>
          </div>
          <div class="nksw-result-wrap" id="nksw-result-wrap">
            <img class="nksw-result-img" id="nksw-result-img" alt="Resultado do provador virtual" />
            <div class="nksw-result-actions">
              <button class="nksw-retry-btn" id="nksw-retry-btn">🔄 Tentar novamente</button>
              <button class="nksw-save-btn"  id="nksw-save-btn">💾 Salvar foto</button>
            </div>
          </div>
          <p class="nksw-disclaimer">
            🔒 Sua foto é processada em tempo real e não é armazenada em nenhum servidor.
          </p>
        </div>
      </div>
    `;
    return overlay;
  }

  // ─── Inicializa o modal para uma instância do widget ──────────────────────
  function initModal(instanceCfg) {
    const apiUrl     = instanceCfg.apiUrl     || CFG.apiUrl;
    const clientKey  = instanceCfg.clientKey  || CFG.clientKey;
    const garmentUrl = toAbsoluteUrl(instanceCfg.garmentUrl || CFG.garmentUrl
      || document.querySelector('[data-vton-image]')?.dataset?.vtonImage
      || document.querySelector('.product__media img')?.src
      || document.querySelector('.product-featured-img')?.src
      || document.querySelector('.woocommerce-product-gallery__image img')?.src
      || document.querySelector('[class*="productImageTag"]')?.src
      || '');
    const category   = instanceCfg.category  || CFG.category;
    const storeName  = instanceCfg.storeName  || CFG.storeName;

    if (!clientKey) { console.error('[Mirage] VTON_CLIENT_KEY não definido.'); return; }

    const overlay    = buildModal(storeName);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Refs
    const $ = id => overlay.querySelector('#' + id);
    const dropZone    = $('nksw-drop-zone');
    const fileInput   = $('nksw-file-input');
    const previewWrap = $('nksw-preview-wrap');
    const previewImg  = $('nksw-preview-img');
    const changeBtn   = $('nksw-change-btn');
    const generateBtn = $('nksw-generate-btn');
    const loading     = $('nksw-loading');
    const loadingText = $('nksw-loading-text');
    const progressBar = $('nksw-progress-bar');
    const errorDiv    = $('nksw-error');
    const leadWrap    = $('nksw-lead');
    const leadInner   = $('nksw-lead-inner');
    const leadName    = $('nksw-lead-name');
    const leadPhone   = $('nksw-lead-phone');
    const leadEmail   = $('nksw-lead-email');
    const leadSubmit  = $('nksw-lead-submit');
    const leadSkip    = $('nksw-lead-skip');
    const leadSent    = $('nksw-lead-sent');
    const resultWrap  = $('nksw-result-wrap');
    const resultImg   = $('nksw-result-img');
    const retryBtn    = $('nksw-retry-btn');
    const saveBtn     = $('nksw-save-btn');
    const closeBtn    = overlay.querySelector('.nksw-close');

    // Estado
    let selectedDataUrl = null;
    let pollTimer       = null;
    let pollStart       = null;
    let currentJobId    = null;
    let pendingLead     = null;
    let leadDone        = false;

    // ── Helpers de UI ──────────────────────────────────────────────────────
    function showError(msg) { errorDiv.textContent = msg; errorDiv.classList.add('visible'); }
    function clearError()   { errorDiv.classList.remove('visible'); }
    function setProgress(p) { progressBar.style.width = `${p}%`; }

    function shakeLeadForm() {
      const steps = [6, -6, 4, -4, 0];
      let delay = 0;
      steps.forEach(x => {
        setTimeout(() => { leadInner.style.transform = `translateX(${x}px)`; }, delay);
        delay += 80;
      });
      setTimeout(() => { leadInner.style.transform = ''; }, delay);
      leadEmail.focus();
    }

    function leadIsBeingFilled() {
      if (leadDone || !leadWrap.classList.contains('visible')) return false;
      return !!(leadName.value.trim() || leadPhone.value.trim() || leadEmail.value.trim());
    }

    // ── Lead submit → Mirage save-lead ────────────────────────────────────
    async function submitLead() {
      const name     = leadName.value.trim();
      const whatsapp = leadPhone.value.trim();
      const email    = leadEmail.value.trim();

      if (!email || !email.includes('@')) { shakeLeadForm(); return; }

      leadSubmit.disabled    = true;
      leadSubmit.textContent = 'Enviando...';

      const lead = { name, email, whatsapp };

      if (!currentJobId) {
        // Job ainda processando — guarda para enviar depois
        pendingLead = lead;
        leadInner.style.display = 'none';
        leadSent.style.display  = 'block';
        leadSent.textContent    = '✅ Dados salvos! Aguardando resultado...';
        leadDone = true;
        return;
      }

      await postLead(lead);
    }

    async function postLead(lead) {
      try {
        await fetch(`${apiUrl}/api/save-lead`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ jobId: currentJobId, clientKey, lead }),
        });
      } catch (_) { /* falha silenciosa */ }

      leadInner.style.display = 'none';
      leadSent.style.display  = 'block';
      leadSent.textContent    = '✅ Cadastro realizado! Fique de olho na sua caixa de entrada.';
      leadDone  = true;
      pendingLead = null;
    }

    leadSubmit.addEventListener('click', submitLead);
    leadSkip.addEventListener('click', () => {
      leadWrap.classList.remove('visible');
      leadDone = true;
    });

    // ── Upload ─────────────────────────────────────────────────────────────
    function setFile(file) {
      clearError();
      const objectUrl = URL.createObjectURL(file);
      previewImg.src  = objectUrl;
      previewImg.onload = () => URL.revokeObjectURL(objectUrl);
      dropZone.style.display = 'none';
      previewWrap.classList.add('visible');
      resultWrap.classList.remove('visible');
      generateBtn.disabled = true;

      processImage(file)
        .then(dataUrl => { selectedDataUrl = dataUrl; generateBtn.disabled = false; })
        .catch(e => { showError(e.message); });
    }

    function resetToUpload() {
      clearInterval(pollTimer);
      selectedDataUrl = null;
      currentJobId    = null;
      pendingLead     = null;
      leadDone        = false;
      fileInput.value = '';
      previewImg.src  = '';
      previewWrap.classList.remove('visible');
      resultWrap.classList.remove('visible');
      loading.classList.remove('visible');
      leadWrap.classList.remove('visible');
      leadInner.style.display = '';
      leadSent.style.display  = 'none';
      leadSubmit.disabled     = false;
      leadSubmit.textContent  = 'Quero receber novidades';
      leadName.value  = '';
      leadPhone.value = '';
      leadEmail.value = '';
      dropZone.style.display = '';
      generateBtn.disabled   = true;
      setProgress(0);
      clearError();
    }

    function closeModal() {
      clearInterval(pollTimer);
      overlay.remove();
      document.body.style.overflow = '';
    }

    function tryClose() {
      if (leadIsBeingFilled()) { shakeLeadForm(); return; }
      closeModal();
    }

    overlay.addEventListener('click', e => { if (e.target === overlay) tryClose(); });
    closeBtn.addEventListener('click', tryClose);
    const onKey = e => {
      if (e.key !== 'Escape') return;
      tryClose();
      if (!leadIsBeingFilled()) document.removeEventListener('keydown', onKey);
    };
    document.addEventListener('keydown', onKey);

    fileInput.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) setFile(f); });
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over');
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type.startsWith('image/')) setFile(f);
    });

    changeBtn.addEventListener('click', resetToUpload);
    retryBtn.addEventListener('click',  resetToUpload);

    // ── Salvar foto ─────────────────────────────────────────────────────────
    saveBtn.addEventListener('click', () => {
      const src = resultImg.src;
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      let blobUrl = null;
      try {
        blobUrl = URL.createObjectURL(dataURLtoBlob(src));
      } catch (_) {}

      if (isIOS) { window.open(blobUrl || src, '_blank'); return; }

      const a = document.createElement('a');
      a.href = blobUrl || src;
      a.download = 'meu-look-mirage.jpg';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); if (blobUrl) URL.revokeObjectURL(blobUrl); }, 200);
    });

    // ── Fluxo principal ────────────────────────────────────────────────────
    generateBtn.addEventListener('click', async () => {
      if (!selectedDataUrl) { showError('Aguarde o processamento da foto.'); return; }
      clearError();
      generateBtn.disabled = true;
      previewWrap.classList.remove('visible');
      resultWrap.classList.remove('visible');
      loading.classList.add('visible');
      if (!leadDone) leadWrap.classList.add('visible');
      loadingText.innerHTML = 'Gerando seu look...<br><small>Aguarde alguns segundos</small>';
      setProgress(10);

      try {
        // 1. Solicita URL assinada para upload no GCS
        const urlRes = await fetch(`${apiUrl}/api/upload-url`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ clientKey, contentType: 'image/jpeg' }),
        });
        const urlData = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlData.error || 'Erro ao gerar URL de upload.');
        setProgress(25);

        // 2. Upload direto para o GCS via PUT
        const blob = dataURLtoBlob(selectedDataUrl);
        const putRes = await fetch(urlData.signedUrl, {
          method:  'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body:    blob,
        });
        if (!putRes.ok) throw new Error('Falha no upload da foto. Tente novamente.');
        setProgress(40);

        // 3. Submete o job (sem lead — salvo depois via save-lead)
        loadingText.innerHTML = 'Gerando seu look...<br><small>Isso leva cerca de 10–20 segundos</small>';
        const submitRes = await fetch(`${apiUrl}/api/submit`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            personImageUrl: urlData.gcsUrl,
            garmentImage:   garmentUrl,
            category,
            clientKey,
            productUrl:     window.location.href,
            productName:    document.title || window.location.hostname,
          }),
        });
        const submitData = await submitRes.json();
        if (!submitRes.ok || !submitData.jobId) throw new Error(submitData.error || 'Falha ao enviar para processamento.');
        currentJobId = submitData.jobId;

        // 4. Se tinha lead pendente (preenchido durante o upload), envia agora
        if (pendingLead) await postLead(pendingLead);

        setProgress(55);

        // 5. Polling do resultado
        pollStart = Date.now();
        await new Promise((resolve, reject) => {
          pollTimer = setInterval(async () => {
            if (Date.now() - pollStart > POLL_TIMEOUT) {
              clearInterval(pollTimer);
              return reject(new Error('O processamento demorou mais que o esperado. Tente novamente.'));
            }
            const elapsed = Date.now() - pollStart;
            setProgress(Math.min(55 + (elapsed / POLL_TIMEOUT) * 40, 93));
            try {
              const pollRes  = await fetch(`${apiUrl}/api/result?jobId=${encodeURIComponent(currentJobId)}`);
              const pollData = await pollRes.json();
              if (pollData.status === 'done' || pollData.status === 'completed') {
                clearInterval(pollTimer);
                setProgress(100);
                resultImg.src = pollData.resultImage || pollData.output;
                resolve();
              } else if (pollData.status === 'error' || pollData.status === 'failed') {
                clearInterval(pollTimer);
                reject(new Error(pollData.error || 'Não foi possível processar. Tente com outra foto.'));
              }
            } catch (_) { /* rede instável — continua */ }
          }, POLL_MS);
        });

        resultWrap.classList.add('visible');

        // Se tinha lead pendente que ainda não foi enviado (job acabou depois)
        if (pendingLead) await postLead(pendingLead);

      } catch (err) {
        showError(err?.message || 'Erro inesperado. Tente novamente.');
        previewWrap.classList.add('visible');
        generateBtn.disabled = false;
        setProgress(0);
      } finally {
        loading.classList.remove('visible');
      }
    });
  }

  // ─── Cria o botão trigger e injeta no anchor ───────────────────────────────
  function createTriggerBtn(anchor) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'nksw-trigger-btn';
    btn.style.cssText = [
      `background:${CFG.btnBg}`,
      `color:${CFG.btnColor}`,
      `width:${CFG.btnWidth}`,
      `height:${CFG.btnHeight}`,
      `border-radius:${CFG.btnRadius}`,
    ].join(';');
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
      ${CFG.btnText}
    `;
    anchor.appendChild(btn);
    return btn;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();

    // Suporte a botões com data-attributes (compatibilidade NKSW)
    document.querySelectorAll('.nksw-tryon-btn').forEach(btn => {
      const apiUrl = btn.dataset.apiUrl || btn.dataset.workerUrl || CFG.apiUrl;
      btn.addEventListener('click', () => initModal({
        apiUrl,
        clientKey:  btn.dataset.clientKey  || CFG.clientKey,
        garmentUrl: btn.dataset.garmentUrl || CFG.garmentUrl,
        category:   btn.dataset.category   || CFG.category,
        storeName:  btn.dataset.storeName  || CFG.storeName,
      }));
    });

    // Modo Mirage padrão: cria botão no #vton-anchor
    const anchor = document.getElementById('vton-anchor');
    if (anchor) {
      const triggerBtn = createTriggerBtn(anchor);
      triggerBtn.addEventListener('click', () => initModal({}));
    } else {
      // Fallback: qualquer elemento com data-vton
      document.querySelectorAll('[data-vton]').forEach(el => {
        el.addEventListener('click', () => initModal({}));
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
