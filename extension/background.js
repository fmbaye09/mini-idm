/**
 * Mini-IDM — Background Service Worker (Manifest V3)
 * Inspiré de background.js d'IDM :
 * 1. Sniffe les requêtes/réponses HTTP via chrome.webRequest (onBeforeSendHeaders & onHeadersReceived).
 * 2. Identifie les fichiers vidéo directs (.mp4, .webm, .mkv, .mov) et les manifestes de streaming (.m3u8, .mpd).
 * 3. Filtre les micro-segments (.ts, .m4s) pour ne garder que les flux maîtres ou fichiers complets.
 * 4. Extrait automatiquement les cookies de session (chrome.cookies.getAll) et les en-têtes (Referer, User-Agent, Origin)
 *    pour les transmettre au serveur local Mini-IDM (http://127.0.0.1:10010).
 */

const SERVER_URL = 'http://127.0.0.1:10010';

// Stockage des flux vidéo détectés par tabId : Map<tabId, Map<url, MediaItem>>
const tabMedia = new Map();
// Cache temporaire des en-têtes de requête par requestId
const pendingRequests = new Map();

// Types MIME vidéo et manifestes reconnus (inspiré de la table Za d'IDM)
const VIDEO_MIME_MAP = {
  'video/mp4': 'MP4',
  'video/webm': 'WEBM',
  'video/ogg': 'OGG',
  'video/quicktime': 'MOV',
  'video/x-matroska': 'MKV',
  'video/x-flv': 'FLV',
  'video/avi': 'AVI',
  'video/msvideo': 'AVI',
  'video/x-msvideo': 'AVI',
  'application/vnd.apple.mpegurl': 'HLS (.m3u8)',
  'application/x-mpegurl': 'HLS (.m3u8)',
  'audio/mpegurl': 'HLS (.m3u8)',
  'audio/x-mpegurl': 'HLS (.m3u8)',
  'application/dash+xml': 'DASH (.mpd)',
  'video/vnd.mpeg.dash.mpd': 'DASH (.mpd)',
};

const EXT_FORMAT_MAP = {
  mp4: 'MP4',
  m4v: 'M4V',
  webm: 'WEBM',
  mkv: 'MKV',
  mov: 'MOV',
  flv: 'FLV',
  m3u8: 'HLS (.m3u8)',
  mpd: 'DASH (.mpd)',
};

// Ignorer les segments individuels de streaming (.ts, .m4s) pour éviter de polluer la liste
const SEGMENT_IGNORE_RE = /\.(?:ts|m4s|f4f|aac|vtt|srt)(?:[?#]|$)|\/seg-\d+|\/fragment-\d+/i;

function getHeader(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === target) {
      return h.value || '';
    }
  }
  return '';
}

function detectMediaFormat(urlStr, contentType = '', contentLength = 0) {
  if (!urlStr || urlStr.startsWith('blob:') || urlStr.startsWith('data:')) return null;
  if (urlStr.startsWith(SERVER_URL)) return null;
  if (SEGMENT_IGNORE_RE.test(urlStr)) return null;

  const cleanMime = (contentType || '').split(';')[0].trim().toLowerCase();

  // Ignorer les petits segments binaires octet-stream ou mp2t
  if (cleanMime === 'video/mp2t' || cleanMime === 'audio/mp2t') {
    return null;
  }

  let format = VIDEO_MIME_MAP[cleanMime] || null;
  let ext = '';
  try {
    const u = new URL(urlStr);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) ext = m[1].toLowerCase();
  } catch (_) {}

  if (!format && ext && EXT_FORMAT_MAP[ext]) {
    format = EXT_FORMAT_MAP[ext];
  }

  if (!format && cleanMime.startsWith('video/')) {
    // Exclure les fragments MP4 de moins de 300 Ko s'ils ressemblent à du DASH
    if (contentLength > 0 && contentLength < 300 * 1024 && /range|segment|frag|chunk/i.test(urlStr)) {
      return null;
    }
    format = cleanMime.slice(6).toUpperCase();
  }

  // Filtrer les micro-vidéos publicitaires / trackers de moins de 150 Ko (sauf manifestes .m3u8 / .mpd)
  const isManifest = format === 'HLS (.m3u8)' || format === 'DASH (.mpd)' || ext === 'm3u8' || ext === 'mpd';
  if (!isManifest && contentLength > 0 && contentLength < 150 * 1024) {
    return null;
  }

  if (!format) return null;

  return {
    format,
    isManifest,
    isHls: format === 'HLS (.m3u8)' || ext === 'm3u8',
    isDash: format === 'DASH (.mpd)' || ext === 'mpd',
  };
}

function registerMediaForTab(tabId, item) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  if (!tabMedia.has(tabId)) {
    tabMedia.set(tabId, new Map());
  }
  const map = tabMedia.get(tabId);
  const existing = map.get(item.url);

  const merged = {
    id: existing ? existing.id : 'm_' + Math.random().toString(36).slice(2, 10),
    url: item.url,
    format: item.format || (existing && existing.format) || 'MP4',
    isManifest: Boolean(item.isManifest || (existing && existing.isManifest)),
    isHls: Boolean(item.isHls || (existing && existing.isHls)),
    isDash: Boolean(item.isDash || (existing && existing.isDash)),
    mimeType: item.mimeType || (existing && existing.mimeType) || '',
    sizeBytes: item.sizeBytes || (existing && existing.sizeBytes) || 0,
    title: item.title || (existing && existing.title) || '',
    referer: item.referer || (existing && existing.referer) || '',
    origin: item.origin || (existing && existing.origin) || '',
    userAgent: item.userAgent || (existing && existing.userAgent) || '',
    variants: (existing && existing.variants) || null,
    detectedAt: existing ? existing.detectedAt : Date.now(),
  };

  map.set(item.url, merged);
  updateTabBadge(tabId);

  // Notifier le content script de l'onglet pour mettre à jour le bouton flottant sur la <video>
  chrome.tabs.sendMessage(
    tabId,
    {
      type: 'TAB_MEDIA_UPDATED',
      mediaList: Array.from(map.values()),
    },
    () => {
      void chrome.runtime.lastError;
    }
  );

  // Si c'est un manifeste HLS (.m3u8) non encore inspecté, demander au serveur local les résolutions disponibles
  if (merged.isHls && !merged.variants && !merged._inspecting) {
    merged._inspecting = true;
    inspectHlsVariants(tabId, merged).catch(() => {});
  }
}

async function inspectHlsVariants(tabId, item) {
  try {
    const cookies = await getCookiesHeader(item.url);
    const res = await fetch(`${SERVER_URL}/api/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: item.url,
        mimeType: item.mimeType,
        referer: item.referer,
        origin: item.origin,
        userAgent: item.userAgent,
        cookies,
      }),
    });
    const data = await res.json();
    if (data && data.ok && data.isHls) {
      item.variants = data.variants || [];
      item.durationSec = data.durationSec || 0;
      const map = tabMedia.get(tabId);
      if (map) {
        chrome.tabs.sendMessage(
          tabId,
          {
            type: 'TAB_MEDIA_UPDATED',
            mediaList: Array.from(map.values()),
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      }
    }
  } catch (_) {}
}

function updateTabBadge(tabId) {
  const map = tabMedia.get(tabId);
  const count = map ? map.size : 0;
  chrome.action.setBadgeText({
    tabId,
    text: count > 0 ? String(count) : '',
  });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({
      tabId,
      color: '#10b981',
    });
  }
}

// 1. Capture des en-têtes de requête (Referer, Origin, User-Agent, Authorization)
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    pendingRequests.set(details.requestId, {
      referer: getHeader(details.requestHeaders, 'Referer'),
      origin: getHeader(details.requestHeaders, 'Origin'),
      userAgent: getHeader(details.requestHeaders, 'User-Agent'),
      authorization: getHeader(details.requestHeaders, 'Authorization'),
      timestamp: Date.now(),
    });
    // Nettoyage périodique du cache
    if (pendingRequests.size > 500) {
      const cutoff = Date.now() - 60000;
      for (const [k, v] of pendingRequests) {
        if (v.timestamp < cutoff) pendingRequests.delete(k);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// 2. Analyse des en-têtes de réponse HTTP (Content-Type, Content-Length, Content-Range)
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const status = details.statusCode;
    if (status !== 200 && status !== 206) return;

    const contentType = getHeader(details.responseHeaders, 'Content-Type');
    const contentRange = getHeader(details.responseHeaders, 'Content-Range');
    const contentLengthHeader = getHeader(details.responseHeaders, 'Content-Length');

    let sizeBytes = Number(contentLengthHeader) || 0;
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)$/);
      if (m) sizeBytes = Number(m[1]);
    }

    const detected = detectMediaFormat(details.url, contentType, sizeBytes);
    if (!detected) return;

    const reqMeta = pendingRequests.get(details.requestId) || {};
    pendingRequests.delete(details.requestId);

    registerMediaForTab(details.tabId, {
      url: details.url,
      format: detected.format,
      isManifest: detected.isManifest,
      isHls: detected.isHls,
      isDash: detected.isDash,
      mimeType: contentType.split(';')[0].trim(),
      sizeBytes,
      referer: reqMeta.referer || details.initiator || '',
      origin: reqMeta.origin || '',
      userAgent: reqMeta.userAgent || '',
      authorization: reqMeta.authorization || '',
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Nettoyer quand l'onglet change de page principale ou est fermé
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabMedia.delete(tabId);
    updateTabBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMedia.delete(tabId);
});

/**
 * Récupère tous les cookies du navigateur pour une URL donnée (comme browser.cookies.getAll dans IDM)
 */
async function getCookiesHeader(urlStr) {
  try {
    const cookies = await chrome.cookies.getAll({ url: urlStr });
    if (!cookies || cookies.length === 0) return '';
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_) {
    return '';
  }
}

/**
 * Envoie une demande de téléchargement au serveur local Mini-IDM
 */
async function triggerServerDownload(payload, senderTab) {
  const targetUrl = payload.variantUrl || payload.url;
  const cookies = await getCookiesHeader(targetUrl);

  const body = {
    url: targetUrl,
    title: payload.title || (senderTab && senderTab.title) || 'video',
    qualityLabel: payload.qualityLabel || '',
    mimeType: payload.mimeType || '',
    sizeBytes: payload.sizeBytes || 0,
    durationSec: payload.durationSec || 0,
    pageUrl: payload.pageUrl || (senderTab && senderTab.url) || '',
    referer: payload.referer || payload.pageUrl || (senderTab && senderTab.url) || '',
    origin: payload.origin || '',
    userAgent: payload.userAgent || navigator.userAgent,
    cookies,
  };

  const res = await fetch(`${SERVER_URL}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Erreur serveur Mini-IDM (${res.status})`);
  }
  return await res.json();
}

// Gestion des messages venant de content.js et popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Content script ou Page Hook a détecté une source <video> ou un manifeste XHR/fetch
  if (msg.type === 'CONTENT_MEDIA_FOUND') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    if (typeof tabId === 'number' && msg.url) {
      const detected = detectMediaFormat(msg.url, msg.mimeType || '', 0) || {
        format: /\.m3u8/i.test(msg.url)
          ? 'HLS (.m3u8)'
          : /\.mpd/i.test(msg.url)
          ? 'DASH (.mpd)'
          : 'MP4',
        isManifest: /\.(?:m3u8|mpd)/i.test(msg.url),
        isHls: /\.m3u8/i.test(msg.url),
        isDash: /\.mpd/i.test(msg.url),
      };
      registerMediaForTab(tabId, {
        url: msg.url,
        format: detected.format,
        isManifest: detected.isManifest,
        isHls: detected.isHls,
        isDash: detected.isDash,
        title: msg.title || (sender.tab && sender.tab.title) || '',
        referer: (sender.tab && sender.tab.url) || msg.pageUrl || '',
        origin: msg.origin || '',
        userAgent: navigator.userAgent,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // Récupérer la liste des vidéos détectées pour un onglet
  if (msg.type === 'GET_TAB_MEDIA') {
    const tabId = msg.tabId ?? (sender.tab && sender.tab.id);
    const map = tabMedia.get(tabId);
    const list = map ? Array.from(map.values()) : [];
    sendResponse({ ok: true, mediaList: list });
    return false;
  }

  // Démarrer le téléchargement via le serveur local Mini-IDM
  if (msg.type === 'START_DOWNLOAD') {
    triggerServerDownload(msg.payload, sender.tab)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          error:
            err.message ||
            'Impossible de contacter le serveur Mini-IDM sur 127.0.0.1:10010. Lancez start-mini-idm.bat !',
        })
      );
    return true; // Réponse asynchrone
  }
});

