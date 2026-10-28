/**
 * Mini-IDM — Content Script
 * Inspiré de content.js + idmbrbtn64.dll d'Internet Download Manager :
 * 1. Observe les éléments <video> du DOM (MutationObserver, ResizeObserver, scroll/resize).
 * 2. Affiche le panneau flottant « ⬇ Télécharger cette vidéo » dans un Shadow DOM isolé
 *    exactement au-dessus du coin supérieur droit du lecteur vidéo actif.
 * 3. Permet de choisir la qualité/flux (MP4 direct, résolutions HLS 1080p/720p/480p, WebM...)
 *    et lance le téléchargement multi-segments en 1 clic vers le serveur local Mini-IDM.
 */

(function () {
  if (window.__mini_idm_content_init__) return;
  window.__mini_idm_content_init__ = true;

  let detectedMedia = [];
  let activeVideo = null;
  let dropdownOpen = false;
  let hideTimeout = null;

  // 1. Écouter les URLs interceptées par page-hook.js (MAIN World)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.__mini_idm__) return;
    if (event.data.type === 'MEDIA_DETECTED' && event.data.url) {
      chrome.runtime.sendMessage({
        type: 'CONTENT_MEDIA_FOUND',
        url: event.data.url,
        title: document.title,
        pageUrl: location.href,
        origin: location.origin,
      });
    }
  });

  // 2. Créer le panneau flottant isolé dans un Shadow DOM (impossible à casser par le CSS du site)
  const hostEl = document.createElement('div');
  hostEl.id = '__mini_idm_overlay_host__';
  hostEl.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = hostEl.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
      .idm-panel {
        position: fixed;
        display: none;
        pointer-events: auto;
        user-select: none;
        z-index: 2147483647;
        filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.45));
        transition: opacity 0.15s ease, transform 0.15s ease;
      }
      .idm-panel.visible {
        display: block;
      }
      .idm-btn-group {
        display: inline-flex;
        align-items: stretch;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        border: 1px solid rgba(16, 185, 129, 0.65);
        border-radius: 8px;
        overflow: hidden;
        color: #f8fafc;
        font-size: 12.5px;
        font-weight: 600;
      }
      .idm-main-btn {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 12px;
        cursor: pointer;
        background: transparent;
        border: none;
        color: #f8fafc;
        font-size: 12.5px;
        font-weight: 600;
        transition: background 0.15s;
      }
      .idm-main-btn:hover {
        background: rgba(16, 185, 129, 0.22);
      }
      .idm-icon {
        width: 18px;
        height: 18px;
        border-radius: 4px;
        background: linear-gradient(135deg, #10b981, #0ea5e9);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
        color: #fff;
      }
      .idm-badge {
        background: #10b981;
        color: #052e16;
        font-size: 10.5px;
        font-weight: 800;
        padding: 1px 6px;
        border-radius: 99px;
      }
      .idm-dropdown-toggle {
        padding: 0 9px;
        background: rgba(255, 255, 255, 0.05);
        border: none;
        border-left: 1px solid rgba(255, 255, 255, 0.12);
        color: #cbd5e1;
        cursor: pointer;
        font-size: 11px;
      }
      .idm-dropdown-toggle:hover {
        background: rgba(16, 185, 129, 0.25);
        color: #fff;
      }
      .idm-menu {
        display: none;
        margin-top: 6px;
        min-width: 280px;
        max-width: 360px;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 6px;
        color: #f8fafc;
        max-height: 280px;
        overflow-y: auto;
      }
      .idm-menu.open {
        display: block;
      }
      .idm-menu-header {
        font-size: 11px;
        color: #94a3b8;
        padding: 4px 8px 6px 8px;
        border-bottom: 1px solid #1e293b;
        margin-bottom: 4px;
        display: flex;
        justify-content: space-between;
      }
      .idm-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.12s;
      }
      .idm-item:hover {
        background: #1e293b;
      }
      .idm-item-left {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow: hidden;
      }
      .idm-item-title {
        font-weight: 600;
        color: #f1f5f9;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .idm-item-sub {
        font-size: 11px;
        color: #94a3b8;
      }
      .idm-tag {
        background: #065f46;
        color: #6ee7b7;
        font-size: 10.5px;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 5px;
        white-space: nowrap;
      }
      .idm-toast {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #0f172a;
        border: 1px solid #10b981;
        color: #f8fafc;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 13px;
        pointer-events: auto;
        display: none;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        z-index: 2147483647;
      }
      .idm-toast.show { display: block; }
    </style>

    <div class="idm-panel" id="panel">
      <div class="idm-btn-group">
        <button class="idm-main-btn" id="mainBtn" title="Télécharger cette vidéo avec Mini-IDM">
          <span class="idm-icon">⬇</span>
          <span>Télécharger cette vidéo</span>
          <span class="idm-badge" id="badgeFmt">MP4</span>
        </button>
        <button class="idm-dropdown-toggle" id="toggleBtn" title="Choisir la résolution / le flux">▼</button>
      </div>
      <div class="idm-menu" id="menu"></div>
    </div>

    <div class="idm-toast" id="toast"></div>
  `;

  document.documentElement.appendChild(hostEl);

  const panelEl = shadow.getElementById('panel');
  const mainBtn = shadow.getElementById('mainBtn');
  const toggleBtn = shadow.getElementById('toggleBtn');
  const badgeFmt = shadow.getElementById('badgeFmt');
  const menuEl = shadow.getElementById('menu');
  const toastEl = shadow.getElementById('toast');

  function showToast(html, isError = false) {
    toastEl.style.borderColor = isError ? '#ef4444' : '#10b981';
    toastEl.innerHTML = html;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 4500);
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'Ko', 'Mo', 'Go'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
  }

  /**
   * Construit la liste de tous les choix téléchargeables (fichiers directs + variantes de résolution HLS)
   */
  function getDownloadOptions() {
    const options = [];
    const seenUrls = new Set();

    // 1. Flux réseau interceptés par background.js
    for (const item of detectedMedia) {
      if (item.isHls && Array.isArray(item.variants) && item.variants.length > 0) {
        for (const v of item.variants) {
          if (seenUrls.has(v.url)) continue;
          seenUrls.add(v.url);
          options.push({
            url: v.url,
            title: cleanPageTitle(),
            qualityLabel: v.label,
            badge: v.height ? `${v.height}p HLS` : 'HLS',
            sub: `Flux adaptatif HLS • Assemblage MP4 auto`,
            mimeType: 'application/vnd.apple.mpegurl',
            sizeBytes: 0,
            durationSec: item.durationSec || (activeVideo && Math.round(activeVideo.duration)) || 0,
          });
        }
      } else if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        const sizeStr = formatSize(item.sizeBytes);
        options.push({
          url: item.url,
          title: cleanPageTitle(),
          qualityLabel: '',
          badge: item.format || 'MP4',
          sub: `${item.format || 'Vidéo'}${sizeStr ? ' • ' + sizeStr : ''} • Multi-segments (8x)`,
          mimeType: item.mimeType || '',
          sizeBytes: item.sizeBytes || 0,
          durationSec: item.durationSec || (activeVideo && Math.round(activeVideo.duration)) || 0,
        });
      }
    }

    // 2. Fallback sur l'attribut currentSrc / src de la balise <video> active si c'est une URL http(s) directe
    if (activeVideo) {
      const src = activeVideo.currentSrc || activeVideo.src;
      if (src && /^https?:\/\//i.test(src) && !seenUrls.has(src)) {
        seenUrls.add(src);
        const resLabel =
          activeVideo.videoHeight > 0 ? `${activeVideo.videoHeight}p` : 'MP4';
        options.push({
          url: src,
          title: cleanPageTitle(),
          qualityLabel: resLabel,
          badge: resLabel,
          sub: `Source directe <video> • Multi-segments (8x)`,
          mimeType: 'video/mp4',
          sizeBytes: 0,
          durationSec: Math.round(activeVideo.duration || 0),
        });
      }
    }

    return options;
  }

  function cleanPageTitle() {
    let t = (document.title || 'video').replace(/^\(\d+\)\s*/, '').trim();
    return t || 'video';
  }

  function renderDropdownMenu() {
    const options = getDownloadOptions();
    if (options.length === 0) {
      menuEl.innerHTML = `
        <div class="idm-menu-header"><span>Aucun flux direct standard détecté</span></div>
        <div style="padding:8px;font-size:11.5px;color:#94a3b8;">
          Lancez la lecture de la vidéo pour que Mini-IDM intercepte son flux réseau.
        </div>
      `;
      return;
    }

    badgeFmt.textContent = options[0].badge;

    menuEl.innerHTML =
      `<div class="idm-menu-header">
        <span>Qualités & Flux détectés (${options.length})</span>
        <span>Mini-IDM</span>
      </div>` +
      options
        .map(
          (opt, idx) => `
        <div class="idm-item" data-idx="${idx}">
          <div class="idm-item-left">
            <div class="idm-item-title">${escapeHtml(opt.title)} ${
            opt.qualityLabel ? '(' + escapeHtml(opt.qualityLabel) + ')' : ''
          }</div>
            <div class="idm-item-sub">${escapeHtml(opt.sub)}</div>
          </div>
          <span class="idm-tag">⬇ ${escapeHtml(opt.badge)}</span>
        </div>
      `
        )
        .join('');

    menuEl.querySelectorAll('.idm-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(el.getAttribute('data-idx'));
        if (options[idx]) {
          startDownload(options[idx]);
          dropdownOpen = false;
          menuEl.classList.remove('open');
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function startDownload(option) {
    showToast(`⏳ Envoi de <b>${escapeHtml(option.title)}</b> à Mini-IDM...`);
    chrome.runtime.sendMessage(
      {
        type: 'START_DOWNLOAD',
        payload: {
          ...option,
          pageUrl: location.href,
          origin: location.origin,
        },
      },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          const errMsg =
            (res && res.error) ||
            'Serveur local Mini-IDM non démarré sur 127.0.0.1:10010. Lancez start-mini-idm.bat !';
          showToast(`❌ ${escapeHtml(errMsg)}`, true);
          return;
        }
        showToast(
          `✅ Téléchargement démarré dans <b>Mini-IDM</b> !<br/><span style="font-size:11.5px;color:#94a3b8;">Mode : ${escapeHtml(
            res.job.mode
          )} — <a href="http://127.0.0.1:10010" target="_blank" style="color:#38bdf8;">Ouvrir la progression</a></span>`
        );
      }
    );
  }

  mainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const options = getDownloadOptions();
    if (options.length === 1) {
      startDownload(options[0]);
    } else {
      dropdownOpen = !dropdownOpen;
      renderDropdownMenu();
      menuEl.classList.toggle('open', dropdownOpen);
    }
  });

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
    renderDropdownMenu();
    menuEl.classList.toggle('open', dropdownOpen);
  });

  panelEl.addEventListener('mouseenter', () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  });

  panelEl.addEventListener('mouseleave', () => {
    if (!dropdownOpen) {
      scheduleHide();
    }
  });

  function scheduleHide() {
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (!dropdownOpen) {
        panelEl.classList.remove('visible');
      }
    }, 1800);
  }

  /**
   * Calcule la géométrie exacte de la balise <video> (inspiré de f.K(a) dans content.js d'IDM)
   * et positionne le bouton flottant au coin supérieur droit du lecteur.
   */
  function updatePanelPosition() {
    if (!activeVideo || !document.contains(activeVideo)) {
      panelEl.classList.remove('visible');
      return;
    }
    const rect = activeVideo.getBoundingClientRect();
    if (rect.width < 140 || rect.height < 90) {
      panelEl.classList.remove('visible');
      return;
    }
    // Vérifier que la vidéo est visible à l'écran
    if (rect.bottom < 40 || rect.top > window.innerHeight - 40) {
      panelEl.classList.remove('visible');
      return;
    }

    const options = getDownloadOptions();
    if (options.length > 0) {
      badgeFmt.textContent = options[0].badge;
    }

    const top = Math.max(8, Math.round(rect.top + 10));
    const left = Math.max(8, Math.min(window.innerWidth - 260, Math.round(rect.right - 250)));

    panelEl.style.top = `${top}px`;
    panelEl.style.left = `${left}px`;
  }

  function showPanelForVideo(video) {
    activeVideo = video;
    // Signaler la source directe éventuelle au background worker
    const src = video.currentSrc || video.src;
    if (src && /^https?:\/\//i.test(src)) {
      chrome.runtime.sendMessage({
        type: 'CONTENT_MEDIA_FOUND',
        url: src,
        title: document.title,
        pageUrl: location.href,
        origin: location.origin,
      });
    }
    updatePanelPosition();
    panelEl.classList.add('visible');
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }

  function attachVideoListeners(video) {
    if (video.__mini_idm_bound__) return;
    video.__mini_idm_bound__ = true;

    const onInteract = () => showPanelForVideo(video);
    video.addEventListener('mouseenter', onInteract, { passive: true });
    video.addEventListener('mousemove', onInteract, { passive: true });
    video.addEventListener('play', onInteract, { passive: true });
    video.addEventListener('loadedmetadata', onInteract, { passive: true });
    video.addEventListener('mouseleave', () => scheduleHide(), { passive: true });

    if (!video.paused || video.readyState >= 1) {
      showPanelForVideo(video);
    }
  }

  function scanVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach(attachVideoListeners);
    if (!activeVideo && videos.length > 0) {
      activeVideo = videos[0];
      updatePanelPosition();
    }
  }

  // Observer les ajouts dynamiques de <video> dans le DOM
  const observer = new MutationObserver(() => scanVideos());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('scroll', updatePanelPosition, { passive: true, capture: true });
  window.addEventListener('resize', updatePanelPosition, { passive: true });
  document.addEventListener('click', () => {
    if (dropdownOpen) {
      dropdownOpen = false;
      menuEl.classList.remove('open');
    }
  });

  // Recevoir les mises à jour de flux réseau depuis background.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TAB_MEDIA_UPDATED') {
      detectedMedia = msg.mediaList || [];
      scanVideos();
      if (activeVideo) {
        updatePanelPosition();
        panelEl.classList.add('visible');
      }
      if (dropdownOpen) {
        renderDropdownMenu();
      }
    }
  });

  // Charger les flux déjà détectés pour cet onglet au démarrage
  chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA' }, (res) => {
    if (res && res.ok && Array.isArray(res.mediaList)) {
      detectedMedia = res.mediaList;
      scanVideos();
    }
  });

  scanVideos();
})();

