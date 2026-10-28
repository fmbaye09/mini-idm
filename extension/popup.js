/**
 * Mini-IDM — Logique de la Popup Extension
 */

const SERVER_URL = 'http://127.0.0.1:10010';

const serverDot = document.getElementById('serverDot');
const serverText = document.getElementById('serverText');
const tabVideos = document.getElementById('tabVideos');
const tabDownloads = document.getElementById('tabDownloads');
const viewVideos = document.getElementById('viewVideos');
const viewDownloads = document.getElementById('viewDownloads');
const countVideos = document.getElementById('countVideos');
const countDownloads = document.getElementById('countDownloads');

let currentTab = null;
let lastDownloadsSignature = '';

function fmtBytes(b) {
  if (!b || b <= 0) return '';
  const u = ['B', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function switchTab(which) {
  const isVid = which === 'videos';
  tabVideos.classList.toggle('active', isVid);
  tabDownloads.classList.toggle('active', !isVid);
  viewVideos.style.display = isVid ? 'block' : 'none';
  viewDownloads.style.display = isVid ? 'none' : 'block';
}

tabVideos.addEventListener('click', () => switchTab('videos'));
tabDownloads.addEventListener('click', () => switchTab('downloads'));

document.getElementById('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: SERVER_URL });
});

document.getElementById('openFolderLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch(`${SERVER_URL}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderOnly: true }),
  }).catch(() => {});
});

// Délégation d'événements sur viewDownloads pour que les clics fonctionnent même pendant un rafraîchissement
viewDownloads.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id');

  if (action === 'play') {
    await fetch(`${SERVER_URL}/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, revealInFolder: false }),
    });
  } else if (action === 'folder') {
    await fetch(`${SERVER_URL}/api/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, revealInFolder: true }),
    });
  } else if (action === 'cancel') {
    await fetch(`${SERVER_URL}/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, remove: true }),
    });
    lastDownloadsSignature = '';
    loadDownloads();
  }
});

async function checkServerStatus() {
  try {
    const r = await fetch(`${SERVER_URL}/api/status`);
    const d = await r.json();
    if (d && d.ok) {
      serverDot.classList.add('online');
      serverText.textContent = 'Connecté au moteur local (127.0.0.1:10010)';
      return true;
    }
  } catch (_) {}
  serverDot.classList.remove('online');
  serverText.textContent = 'Serveur local hors-ligne (lancez start-mini-idm.bat)';
  return false;
}

function renderDetectedVideos(mediaList) {
  const items = [];
  for (const m of mediaList) {
    if (m.isHls && Array.isArray(m.variants) && m.variants.length > 0) {
      for (const v of m.variants) {
        items.push({
          url: v.url,
          title: m.title || (currentTab && currentTab.title) || 'video',
          qualityLabel: v.label,
          badge: v.height ? `${v.height}p HLS` : 'HLS',
          sizeBytes: 0,
          mimeType: 'application/vnd.apple.mpegurl',
          durationSec: m.durationSec || 0,
        });
      }
    } else {
      items.push({
        url: m.url,
        title: m.title || (currentTab && currentTab.title) || 'video',
        qualityLabel: '',
        badge: m.format || 'MP4',
        sizeBytes: m.sizeBytes || 0,
        mimeType: m.mimeType || '',
        durationSec: m.durationSec || 0,
      });
    }
  }

  countVideos.textContent = String(items.length);

  if (items.length === 0) {
    viewVideos.innerHTML = `
      <div class="empty">
        Aucune vidéo détectée sur cet onglet pour l'instant.<br/><br/>
        💡 Lancez la lecture d'une vidéo sur la page ou survolez le lecteur <code>&lt;video&gt;</code> pour faire apparaître le bouton flottant <b>« Télécharger cette vidéo »</b>.
      </div>
    `;
    return;
  }

  viewVideos.innerHTML = items
    .map(
      (it, idx) => `
      <div class="item">
        <div class="item-top">
          <div class="item-title">${escapeHtml(it.title)} ${
        it.qualityLabel ? '[' + escapeHtml(it.qualityLabel) + ']' : ''
      }</div>
          <span class="tag">${escapeHtml(it.badge)}</span>
        </div>
        <div class="item-meta">
          <span>${
            it.sizeBytes > 0 ? '📦 ' + fmtBytes(it.sizeBytes) : '⚡ Flux prêt à capturer'
          }</span>
          <button class="btn dl-btn" data-idx="${idx}">⬇ Télécharger</button>
        </div>
      </div>
    `
    )
    .join('');

  viewVideos.querySelectorAll('.dl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.getAttribute('data-idx'));
      const chosen = items[idx];
      if (!chosen) return;
      btn.disabled = true;
      btn.textContent = '⏳ Envoi...';
      chrome.runtime.sendMessage(
        {
          type: 'START_DOWNLOAD',
          payload: {
            ...chosen,
            pageUrl: currentTab ? currentTab.url : '',
          },
        },
        (res) => {
          if (res && res.ok) {
            switchTab('downloads');
            lastDownloadsSignature = '';
            loadDownloads();
          } else {
            btn.disabled = false;
            btn.textContent = '❌ Serveur off';
          }
        }
      );
    });
  });
}

async function loadDownloads() {
  try {
    const r = await fetch(`${SERVER_URL}/api/downloads`);
    const d = await r.json();
    if (!d || !d.ok) return;
    const jobs = d.jobs || [];
    countDownloads.textContent = String(jobs.length);

    const sig = JSON.stringify(
      jobs.map((j) => [j.id, j.status, j.progress, j.downloadedBytes, j.speedBps])
    );
    if (sig === lastDownloadsSignature) return;
    lastDownloadsSignature = sig;

    if (jobs.length === 0) {
      viewDownloads.innerHTML = `<div class="empty">Aucun téléchargement actif ou terminé.</div>`;
      return;
    }

    viewDownloads.innerHTML = jobs
      .map((j) => {
        const segBar =
          j.segments && j.segments.length > 1
            ? `<div class="seg-row">` +
              j.segments
                .map((s) => {
                  const p = s.total > 0 ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : 0;
                  return `<div class="seg"><div class="seg-in" style="width:${p}%"></div></div>`;
                })
                .join('') +
              `</div>`
            : '';

        return `
          <div class="item">
            <div class="item-top">
              <div class="item-title">${escapeHtml(j.filename)}</div>
              <span class="tag">${escapeHtml(j.status.toUpperCase())}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${j.progress || 0}%"></div>
            </div>
            ${segBar}
            <div class="item-meta">
              <span>${fmtBytes(j.downloadedBytes)}${
          j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : ''
        } (${j.progress || 0}%) ${j.speedBps > 0 ? '• ' + fmtBytes(j.speedBps) + '/s' : ''}</span>
              <div style="display:flex;gap:4px;">
                ${
                  j.status === 'completed'
                    ? `<button class="btn" data-action="play" data-id="${escapeHtml(j.id)}">▶ Lire</button>
                       <button class="btn btn-sec" data-action="folder" data-id="${escapeHtml(j.id)}" title="Afficher dans le dossier">📂</button>`
                    : `<button class="btn btn-sec" data-action="cancel" data-id="${escapeHtml(j.id)}" title="Annuler">⏹</button>`
                }
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (_) {}
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  currentTab = tabs && tabs[0];
  await checkServerStatus();

  if (currentTab) {
    chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA', tabId: currentTab.id }, (res) => {
      if (res && res.ok) {
        renderDetectedVideos(res.mediaList || []);
      }
    });
  }

  await loadDownloads();
  setInterval(loadDownloads, 1000);
});
