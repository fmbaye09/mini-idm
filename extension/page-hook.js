/**
 * Mini-IDM — Page Hook (MAIN World)
 * Inspiré de document.js dans l'extension d'IDM :
 * Intercepte les appels XMLHttpRequest, window.fetch et les assignations HTMLMediaElement.src
 * pour détecter immédiatement les manifestes HLS (.m3u8), DASH (.mpd) et flux directs (.mp4, .webm)
 * chargés par les lecteurs vidéo JavaScript (hls.js, dash.js, Video.js, Shaka, Plyr...).
 */
(function () {
  if (window.__mini_idm_page_hook__) return;
  window.__mini_idm_page_hook__ = true;

  const MEDIA_URL_RE =
    /\.(?:mp4|webm|m3u8|mpd|m4v|mov|mkv|flv)(?:[?#]|$)|\/manifest\.m3u8|\/playlist\.m3u8|mime=video/i;

  function notifyMediaUrl(rawUrl, sourceKind) {
    try {
      if (!rawUrl || typeof rawUrl !== 'string') return;
      if (rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return;
      const absUrl = new URL(rawUrl, location.href).toString();
      if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) return;
      if (!MEDIA_URL_RE.test(absUrl)) return;

      window.postMessage(
        {
          __mini_idm__: true,
          type: 'MEDIA_DETECTED',
          url: absUrl,
          sourceKind,
          pageTitle: document.title || '',
        },
        '*'
      );
    } catch (_) {}
  }

  // 1. Hook XMLHttpRequest.prototype.open
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const urlStr = typeof url === 'string' ? url : url && url.toString();
      notifyMediaUrl(urlStr, 'xhr');
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  // 2. Hook window.fetch
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      try {
        const urlStr =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
            ? input.url
            : '';
        notifyMediaUrl(urlStr, 'fetch');
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  // 3. Hook HTMLMediaElement.prototype.src
  try {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.set) {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (val) {
          notifyMediaUrl(val, 'video.src');
          return desc.set.call(this, val);
        },
      });
    }
  } catch (_) {}
})();

