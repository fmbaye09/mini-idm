/**
 * Mini-IDM Local Companion Server & Multi-Segment / HLS Download Engine
 * Inspiré de l'architecture d'Internet Download Manager (IDMan.exe + IDMVMPrs64.dll + idmvconv.dll)
 *
 * Fonctionnalités :
 * 1. Réception des métadonnées réseau depuis l'extension navigateur (URL, Cookies, Referer, User-Agent, Origin, Titre).
 * 2. Analyse des manifestes HLS (.m3u8) pour lister les résolutions disponibles (#EXT-X-STREAM-INF).
 * 3. Téléchargement HTTP/HTTPS multi-segments parallèle (8 connexions simultanées avec en-têtes Range: bytes=start-end).
 * 4. Téléchargement et assemblage/muxing automatique des flux HLS (.m3u8) et DASH (.mpd) en conteneur .mp4 via FFmpeg (comme idmvconv.dll).
 * 5. Dashboard Web temps réel sur http://127.0.0.1:10010 + persistance de l'historique des fichiers téléchargés.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');

const PORT = Number(process.env.MINI_IDM_PORT || 10010);
const HOST = '127.0.0.1';
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Mini-IDM');
const HISTORY_FILE = path.join(DEFAULT_DOWNLOAD_DIR, '.mini-idm-history.json');
const DEFAULT_SEGMENTS = 8;

// Assurer que le dossier de téléchargement existe
fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });

// État en mémoire des téléchargements (ID -> Job)
const jobs = new Map();
// Clients SSE connectés pour les mises à jour temps réel
const sseClients = new Set();

/**
 * Charge l'historique persistant et scanne les vidéos déjà présentes dans le dossier Mini-IDM
 */
function loadExistingHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(saved)) {
        for (const item of saved) {
          if (item && item.id && item.filePath && fs.existsSync(item.filePath)) {
            jobs.set(item.id, {
              ...item,
              status: item.status === 'completed' ? 'completed' : 'cancelled',
              speedBps: 0,
              etaSec: null,
              activeRequests: new Set(),
              ffmpegProc: null,
            });
          }
        }
      }
    }
  } catch (_) {}

  // Scanner aussi les fichiers vidéo présents dans DEFAULT_DOWNLOAD_DIR qui ne seraient pas dans l'historique
  try {
    const knownPaths = new Set(Array.from(jobs.values()).map((j) => path.resolve(j.filePath)));
    const entries = fs.readdirSync(DEFAULT_DOWNLOAD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.mp4', '.webm', '.mkv', '.mov', '.flv', '.mp3', '.m4a', '.ts'].includes(ext)) continue;
      const fullPath = path.resolve(DEFAULT_DOWNLOAD_DIR, entry.name);
      if (knownPaths.has(fullPath)) continue;
      const stat = fs.statSync(fullPath);
      const id = 'dl_' + crypto.createHash('md5').update(fullPath).digest('hex').slice(0, 12);
      jobs.set(id, {
        id,
        title: path.basename(entry.name, ext),
        filename: entry.name,
        filePath: fullPath,
        url: '',
        mode: 'Téléchargé avec Mini-IDM',
        status: 'completed',
        error: null,
        totalBytes: stat.size,
        downloadedBytes: stat.size,
        progress: 100,
        speedBps: 0,
        etaSec: null,
        createdAt: stat.birthtimeMs || stat.mtimeMs || Date.now(),
        completedAt: stat.mtimeMs || Date.now(),
        activeRequests: new Set(),
        ffmpegProc: null,
        segments: [{ index: 0, start: 0, end: 100, downloaded: 100, total: 100, status: 'completed' }],
      });
    }
  } catch (_) {}
}

function saveHistory() {
  try {
    const data = serializeJobs();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

loadExistingHistory();

/**
 * Nettoie un nom de fichier pour Windows
 */
function sanitizeFilename(name, fallbackExt = '.mp4') {
  let base = (name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) base = 'video';
  if (base.length > 140) base = base.slice(0, 140).trim();
  const ext = path.extname(base).toLowerCase();
  const validExts = ['.mp4', '.webm', '.mkv', '.mov', '.flv', '.mp3', '.m4a', '.aac', '.ts'];
  if (!validExts.includes(ext)) {
    base += fallbackExt;
  }
  return base;
}

/**
 * Génère un chemin de fichier unique pour éviter d'écraser un fichier existant
 */
function getUniqueFilePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

/**
 * Construit les en-têtes HTTP fidèles à la session du navigateur
 */
function buildBrowserHeaders(meta = {}, extra = {}) {
  const headers = {
    'User-Agent':
      meta.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    Connection: 'keep-alive',
    ...extra,
  };
  if (meta.referer) headers['Referer'] = meta.referer;
  if (meta.origin) headers['Origin'] = meta.origin;
  if (meta.cookies) headers['Cookie'] = meta.cookies;
  if (meta.authorization) headers['Authorization'] = meta.authorization;
  return headers;
}

/**
 * Effectue une requête HTTP/HTTPS en suivant les redirections (301, 302, 303, 307, 308)
 */
function requestWithRedirects(targetUrl, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 20000,
        rejectUnauthorized: false,
      },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          resolve(requestWithRedirects(nextUrl, options, maxRedirects - 1));
          return;
        }
        resolve({ res, finalUrl: targetUrl, req });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Télécharge le texte d'une URL (ex: manifeste .m3u8)
 */
async function fetchText(targetUrl, meta = {}) {
  const headers = buildBrowserHeaders(meta);
  const { res, finalUrl } = await requestWithRedirects(targetUrl, {
    method: 'GET',
    headers,
  });
  if (res.statusCode < 200 || res.statusCode >= 400) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode} lors de la lecture du manifeste`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > 5 * 1024 * 1024) {
      reqDestroySafe(res);
      throw new Error('Manifeste trop volumineux (> 5 Mo)');
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), finalUrl };
}

function reqDestroySafe(stream) {
  try {
    stream.destroy();
  } catch (_) {}
}

/**
 * Parseur de manifeste HLS (.m3u8) - inspiré d'IDMVMPrs64.dll
 */
async function parseHlsManifest(manifestUrl, meta = {}) {
  const { text, finalUrl } = await fetchText(manifestUrl, meta);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) {
    return { isHls: false, variants: [] };
  }

  const variants = [];
  let totalDuration = 0;
  let segmentCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
      const resMatch = attrs.match(/RESOLUTION=(\d+x\d+)/i);
      const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
      const nameMatch = attrs.match(/NAME="([^"]+)"/i);
      const codecsMatch = attrs.match(/CODECS="([^"]+)"/i);

      let nextUri = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          nextUri = lines[j];
          i = j;
          break;
        }
      }
      if (nextUri) {
        const resolvedUrl = new URL(nextUri, finalUrl).toString();
        const resolution = resMatch ? resMatch[1] : null;
        const height = resolution ? Number(resolution.split('x')[1]) : null;
        const bandwidth = bwMatch ? Number(bwMatch[1]) : 0;
        const label = height
          ? `${height}p (${resolution})`
          : nameMatch
          ? nameMatch[1]
          : bandwidth
          ? `${Math.round(bandwidth / 1000)} kbps`
          : 'Flux HLS';

        variants.push({
          url: resolvedUrl,
          resolution,
          height: height || 0,
          bandwidth,
          codecs: codecsMatch ? codecsMatch[1] : null,
          label,
        });
      }
    } else if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
      if (!Number.isNaN(dur)) totalDuration += dur;
      segmentCount++;
    }
  }

  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);

  return {
    isHls: true,
    isMaster: variants.length > 0,
    variants,
    segmentCount,
    durationSec: Math.round(totalDuration),
  };
}

/**
 * Sonde une URL vidéo directe pour connaître sa taille et le support Range
 */
async function probeDirectUrl(targetUrl, meta = {}) {
  const headers = buildBrowserHeaders(meta, { Range: 'bytes=0-0' });
  const { res, finalUrl } = await requestWithRedirects(targetUrl, {
    method: 'GET',
    headers,
  });

  const statusCode = res.statusCode;
  const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase();
  const contentRange = res.headers['content-range'] || '';
  const contentDisposition = res.headers['content-disposition'] || '';
  let totalBytes = 0;
  let supportsRange = false;

  if (statusCode === 206 && contentRange) {
    supportsRange = true;
    const m = contentRange.match(/\/(\d+)$/);
    if (m) totalBytes = Number(m[1]);
  } else if (res.headers['content-length']) {
    totalBytes = Number(res.headers['content-length']);
    supportsRange = acceptRanges.includes('bytes');
  }

  res.destroy();

  return {
    finalUrl,
    statusCode,
    contentType,
    totalBytes,
    supportsRange: supportsRange && totalBytes > 512 * 1024,
    contentDisposition,
  };
}

/**
 * Diffuse l'état des téléchargements à tous les clients SSE
 */
function broadcastJobs() {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({
    type: 'jobs',
    jobs: serializeJobs(),
  });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

function serializeJobs() {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => ({
      id: j.id,
      title: j.title,
      filename: j.filename,
      filePath: j.filePath,
      url: j.url,
      mode: j.mode,
      status: j.status,
      error: j.error || null,
      totalBytes: j.totalBytes,
      downloadedBytes: j.downloadedBytes,
      progress: j.progress,
      speedBps: j.speedBps,
      etaSec: j.etaSec,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      segments: (j.segments || []).map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        downloaded: s.downloaded,
        total: s.total,
        status: s.status,
      })),
    }));
}

/**
 * MOTEUR 1 : Téléchargement HTTP/HTTPS Multi-Segments (comme IDMan.exe)
 */
async function runMultiSegmentDownload(job) {
  job.status = 'probing';
  broadcastJobs();

  const probe = await probeDirectUrl(job.url, job.meta);
  job.finalUrl = probe.finalUrl;
  job.totalBytes = probe.totalBytes;

  const numSegments =
    probe.supportsRange && probe.totalBytes > 2 * 1024 * 1024 ? job.segmentCount || DEFAULT_SEGMENTS : 1;

  job.mode = numSegments > 1 ? `Multi-Segments (${numSegments}x)` : 'Flux Direct (1x)';
  job.status = 'downloading';

  const tempDir = path.join(DEFAULT_DOWNLOAD_DIR, `.tmp_${job.id}`);
  await fsp.mkdir(tempDir, { recursive: true });

  if (numSegments === 1) {
    job.segments = [
      {
        index: 0,
        start: 0,
        end: probe.totalBytes ? probe.totalBytes - 1 : 0,
        downloaded: 0,
        total: probe.totalBytes || 0,
        status: 'downloading',
        partPath: path.join(tempDir, 'part_0'),
      },
    ];
  } else {
    const chunkSize = Math.floor(probe.totalBytes / numSegments);
    job.segments = [];
    for (let i = 0; i < numSegments; i++) {
      const start = i * chunkSize;
      const end = i === numSegments - 1 ? probe.totalBytes - 1 : (i + 1) * chunkSize - 1;
      job.segments.push({
        index: i,
        start,
        end,
        downloaded: 0,
        total: end - start + 1,
        status: 'pending',
        partPath: path.join(tempDir, `part_${i}`),
      });
    }
  }

  broadcastJobs();

  let lastBytes = 0;
  let lastTick = Date.now();
  const speedTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    if (dt >= 0.4) {
      const currentBytes = job.segments.reduce((acc, s) => acc + s.downloaded, 0);
      job.downloadedBytes = currentBytes;
      job.speedBps = Math.max(0, Math.round((currentBytes - lastBytes) / dt));
      if (job.totalBytes > 0) {
        job.progress = Math.min(99.9, Number(((currentBytes / job.totalBytes) * 100).toFixed(1)));
        job.etaSec =
          job.speedBps > 0 ? Math.max(0, Math.round((job.totalBytes - currentBytes) / job.speedBps)) : null;
      }
      lastBytes = currentBytes;
      lastTick = now;
      broadcastJobs();
    }
  }, 500);

  try {
    await Promise.all(
      job.segments.map((seg) => downloadSingleSegment(job, seg, numSegments > 1))
    );

    clearInterval(speedTimer);
    if (job.aborted) throw new Error('Téléchargement annulé');

    job.status = 'merging';
    job.speedBps = 0;
    broadcastJobs();

    const writeStream = fs.createWriteStream(job.filePath);
    for (const seg of job.segments) {
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(seg.partPath);
        readStream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }
    await new Promise((resolve) => writeStream.end(resolve));

    await fsp.rm(tempDir, { recursive: true, force: true });

    const stat = await fsp.stat(job.filePath);
    job.downloadedBytes = stat.size;
    job.totalBytes = stat.size;
    job.progress = 100;
    job.status = 'completed';
    job.completedAt = Date.now();
    saveHistory();
    broadcastJobs();
  } catch (err) {
    clearInterval(speedTimer);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (job.aborted) {
      job.status = 'cancelled';
      job.error = 'Annulé par l’utilisateur';
    } else {
      job.status = 'error';
      job.error = err.message || String(err);
    }
    job.speedBps = 0;
    saveHistory();
    broadcastJobs();
  }
}

async function downloadSingleSegment(job, seg, useRange, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (job.aborted) throw new Error('Aborted');
    try {
      seg.status = 'downloading';
      const resumeOffset = seg.downloaded || 0;
      const rangeStart = seg.start + resumeOffset;
      if (useRange && rangeStart > seg.end) {
        seg.status = 'completed';
        return;
      }

      const extraHeaders = useRange ? { Range: `bytes=${rangeStart}-${seg.end}` } : {};
      const headers = buildBrowserHeaders(job.meta, extraHeaders);

      const { res, req } = await requestWithRedirects(job.finalUrl || job.url, {
        method: 'GET',
        headers,
      });

      job.activeRequests.add(req);

      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.destroy();
        throw new Error(`HTTP ${res.statusCode} sur le segment #${seg.index + 1}`);
      }

      const flags = resumeOffset > 0 && res.statusCode === 206 ? 'a' : 'w';
      if (flags === 'w') seg.downloaded = 0;

      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(seg.partPath, { flags });
        res.on('data', (chunk) => {
          if (job.aborted) {
            req.destroy();
            fileStream.destroy();
            reject(new Error('Aborted'));
            return;
          }
          seg.downloaded += chunk.length;
        });
        res.on('error', (err) => {
          fileStream.destroy();
          reject(err);
        });
        fileStream.on('error', reject);
        fileStream.on('finish', resolve);
        res.pipe(fileStream);
      });

      job.activeRequests.delete(req);
      seg.status = 'completed';
      return;
    } catch (err) {
      if (job.aborted || attempt === retries) {
        seg.status = 'error';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

/**
 * MOTEUR 2 : Téléchargement et Muxing de flux adaptatifs HLS (.m3u8) / DASH (.mpd) via FFmpeg
 */
async function runFfmpegStreamDownload(job) {
  job.mode = 'Flux Adaptatif HLS/DASH (FFmpeg Muxer)';
  job.status = 'downloading';
  job.segments = [
    {
      index: 0,
      start: 0,
      end: 100,
      downloaded: 0,
      total: 100,
      status: 'downloading',
    },
  ];
  broadcastJobs();

  const headerLines = [];
  if (job.meta.referer) headerLines.push(`Referer: ${job.meta.referer}`);
  if (job.meta.origin) headerLines.push(`Origin: ${job.meta.origin}`);
  if (job.meta.cookies) headerLines.push(`Cookie: ${job.meta.cookies}`);
  if (job.meta.authorization) headerLines.push(`Authorization: ${job.meta.authorization}`);
  const rawHeaders = headerLines.length > 0 ? headerLines.join('\r\n') + '\r\n' : '';

  const userAgent =
    job.meta.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const args = ['-y', '-user_agent', userAgent];
  if (rawHeaders) {
    args.push('-headers', rawHeaders);
  }
  args.push(
    '-i',
    job.url,
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    '-movflags',
    '+faststart',
    job.filePath
  );

  let totalDurationSec = job.meta.durationSec || 0;
  let lastBytes = 0;
  let lastTime = Date.now();

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { windowsHide: true });
    job.ffmpegProc = proc;

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (!totalDurationSec) {
        const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durMatch) {
          totalDurationSec =
            Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + parseFloat(durMatch[3]);
        }
      }

      const sizeMatch = text.match(/size=\s*(\d+)\s*kB/i);
      const timeMatch = text.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);

      const now = Date.now();
      if (sizeMatch) {
        const currentBytes = Number(sizeMatch[1]) * 1024;
        const dt = (now - lastTime) / 1000;
        if (dt >= 0.4) {
          job.speedBps = Math.max(0, Math.round((currentBytes - lastBytes) / dt));
          lastBytes = currentBytes;
          lastTime = now;
        }
        job.downloadedBytes = currentBytes;
      }

      if (timeMatch && totalDurationSec > 0) {
        const currentSec =
          Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        const pct = Math.min(99.5, Number(((currentSec / totalDurationSec) * 100).toFixed(1)));
        job.progress = pct;
        job.segments[0].downloaded = Math.round(pct);
        if (job.speedBps > 0 && pct > 1) {
          job.totalBytes = Math.round(job.downloadedBytes / (pct / 100));
        }
      }
      broadcastJobs();
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      job.ffmpegProc = null;
      if (job.aborted) {
        reject(new Error('Annulé par l’utilisateur'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg s'est terminé avec le code ${code}`));
      }
    });
  });

  const stat = await fsp.stat(job.filePath);
  job.downloadedBytes = stat.size;
  job.totalBytes = stat.size;
  job.progress = 100;
  job.segments[0].downloaded = 100;
  job.segments[0].status = 'completed';
  job.speedBps = 0;
  job.status = 'completed';
  job.completedAt = Date.now();
  saveHistory();
  broadcastJobs();
}

function startDownloadJob(payload) {
  const id = 'dl_' + crypto.randomBytes(6).toString('hex');
  const url = payload.url;
  const isStreamManifest =
    /\.m3u8(\?|$)/i.test(url) ||
    /\.mpd(\?|$)/i.test(url) ||
    (payload.mimeType && /mpegurl|dash\+xml/i.test(payload.mimeType));

  const fallbackExt = isStreamManifest ? '.mp4' : guessExtension(url, payload.mimeType);
  const rawTitle = payload.title || guessFilenameFromUrl(url) || 'video';
  const filename = sanitizeFilename(
    payload.qualityLabel ? `${rawTitle} [${payload.qualityLabel}]` : rawTitle,
    fallbackExt
  );
  const filePath = getUniqueFilePath(DEFAULT_DOWNLOAD_DIR, filename);

  const job = {
    id,
    title: rawTitle,
    filename: path.basename(filePath),
    filePath,
    url,
    mode: isStreamManifest ? 'Flux Adaptatif HLS/DASH' : 'Multi-Segments (8x)',
    status: 'queued',
    error: null,
    totalBytes: Number(payload.sizeBytes) || 0,
    downloadedBytes: 0,
    progress: 0,
    speedBps: 0,
    etaSec: null,
    segmentCount: Number(payload.segments) || DEFAULT_SEGMENTS,
    createdAt: Date.now(),
    completedAt: null,
    aborted: false,
    activeRequests: new Set(),
    ffmpegProc: null,
    segments: [],
    meta: {
      referer: payload.referer || payload.pageUrl || '',
      origin: payload.origin || '',
      cookies: payload.cookies || '',
      userAgent: payload.userAgent || '',
      authorization: payload.authorization || '',
      durationSec: Number(payload.durationSec) || 0,
    },
  };

  jobs.set(id, job);
  saveHistory();
  broadcastJobs();

  if (isStreamManifest) {
    runFfmpegStreamDownload(job).catch((err) => {
      job.status = job.aborted ? 'cancelled' : 'error';
      job.error = err.message;
      job.speedBps = 0;
      saveHistory();
      broadcastJobs();
    });
  } else {
    runMultiSegmentDownload(job).catch((err) => {
      job.status = job.aborted ? 'cancelled' : 'error';
      job.error = err.message;
      job.speedBps = 0;
      saveHistory();
      broadcastJobs();
    });
  }

  return job;
}

function guessExtension(urlStr, mimeType = '') {
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('matroska') || mime.includes('mkv')) return '.mkv';
  if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
  if (mime.includes('flv')) return '.flv';
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3';
  try {
    const u = new URL(urlStr);
    const ext = path.extname(u.pathname).toLowerCase();
    if (['.mp4', '.webm', '.mkv', '.mov', '.flv', '.mp3', '.m4a', '.aac'].includes(ext)) {
      return ext;
    }
  } catch (_) {}
  return '.mp4';
}

function guessFilenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname);
    if (base && base !== '/' && !base.endsWith('.m3u8') && !base.endsWith('.mpd')) {
      return decodeURIComponent(base.replace(/\.[a-z0-9]{2,5}$/i, ''));
    }
  } catch (_) {}
  return 'video';
}

/**
 * Ouvre l'Explorateur Windows ou le lecteur multimédia par défaut de façon fiable sous Windows :
 * Utilise windowsVerbatimArguments: true pour éviter que Node n'entoure "/select,C:\..." de guillemets
 * (ce qui casse l'analyseur d'arguments de explorer.exe).
 */
function openInWindowsExplorer({ folderOnly, revealInFolder, targetPath }) {
  if (folderOnly) {
    spawn('explorer.exe', [`"${DEFAULT_DOWNLOAD_DIR}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }

  if (revealInFolder) {
    spawn('explorer.exe', [`/select,"${targetPath}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }

  // Lecture directe du fichier avec l'application par défaut de Windows
  spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${targetPath}"`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        name: 'Mini-IDM Companion Server',
        version: '1.0.0',
        downloadDir: DEFAULT_DOWNLOAD_DIR,
        activeCount: Array.from(jobs.values()).filter((j) =>
          ['queued', 'probing', 'downloading', 'merging'].includes(j.status)
        ).length,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'jobs', jobs: serializeJobs() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/downloads') {
      sendJson(res, 200, { ok: true, downloadDir: DEFAULT_DOWNLOAD_DIR, jobs: serializeJobs() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/inspect') {
      const body = await readJsonBody(req);
      if (!body.url) {
        sendJson(res, 400, { ok: false, error: 'Missing url' });
        return;
      }
      if (/\.m3u8(\?|$)/i.test(body.url) || (body.mimeType && /mpegurl/i.test(body.mimeType))) {
        const hlsInfo = await parseHlsManifest(body.url, body);
        sendJson(res, 200, { ok: true, kind: 'hls', ...hlsInfo });
      } else {
        const probe = await probeDirectUrl(body.url, body);
        sendJson(res, 200, { ok: true, kind: 'direct', ...probe });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/download') {
      const body = await readJsonBody(req);
      if (!body.url) {
        sendJson(res, 400, { ok: false, error: 'Missing url' });
        return;
      }
      const job = startDownloadJob(body);
      sendJson(res, 200, { ok: true, job: serializeJobs().find((j) => j.id === job.id) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cancel') {
      const body = await readJsonBody(req);
      const job = jobs.get(body.id);
      if (job) {
        job.aborted = true;
        for (const r of job.activeRequests) {
          try {
            r.destroy();
          } catch (_) {}
        }
        if (job.ffmpegProc) {
          try {
            job.ffmpegProc.kill('SIGTERM');
          } catch (_) {}
        }
        if (body.remove) {
          jobs.delete(body.id);
        }
        saveHistory();
        broadcastJobs();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // 7. Ouvrir le fichier ou son dossier dans l'Explorateur Windows
    if (req.method === 'POST' && pathname === '/api/open') {
      const body = await readJsonBody(req);
      if (body.folderOnly) {
        openInWindowsExplorer({ folderOnly: true });
        sendJson(res, 200, { ok: true });
        return;
      }
      const job = jobs.get(body.id);
      if (!job || !fs.existsSync(job.filePath)) {
        sendJson(res, 404, { ok: false, error: 'Fichier introuvable sur le disque' });
        return;
      }
      openInWindowsExplorer({
        folderOnly: false,
        revealInFolder: Boolean(body.revealInFolder),
        targetPath: job.filePath,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Mini-IDM — Gestionnaire de Téléchargement Vidéo</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --border: #334155;
      --accent: #10b981;
      --accent-hover: #059669;
      --blue: #3b82f6;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
    }
    .container { max-width: 1080px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 18px 24px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-icon {
      width: 42px; height: 42px; border-radius: 10px;
      background: linear-gradient(135deg, #10b981, #0ea5e9);
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 20px; color: #fff;
    }
    h1 { margin: 0; font-size: 20px; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .btn {
      background: var(--accent); color: #fff; border: none;
      padding: 9px 15px; border-radius: 8px; cursor: pointer;
      font-weight: 600; font-size: 13px; transition: 0.15s;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn-secondary { background: #334155; }
    .btn-secondary:hover { background: #475569; }
    .grid { display: grid; grid-template-columns: 1fr 360px; gap: 20px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
    }
    .card h2 { margin: 0 0 14px 0; font-size: 16px; display: flex; justify-content: space-between; align-items: center; }
    .manual-bar { display: flex; gap: 8px; margin-bottom: 16px; }
    .manual-bar input {
      flex: 1; background: #0f172a; border: 1px solid var(--border);
      color: var(--text); padding: 10px 12px; border-radius: 8px; font-size: 13px;
    }
    .job {
      background: #0f172a; border: 1px solid var(--border);
      border-radius: 10px; padding: 14px; margin-bottom: 12px;
    }
    .job-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .job-title { font-weight: 600; font-size: 14px; word-break: break-all; }
    .job-meta { color: var(--muted); font-size: 12px; margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
    .badge {
      padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600;
      background: #1e3a8a; color: #93c5fd;
    }
    .badge.completed { background: #064e3b; color: #6ee7b7; }
    .badge.error { background: #7f1d1d; color: #fca5a5; }
    .progress-bar {
      height: 8px; background: #1e293b; border-radius: 99px;
      overflow: hidden; margin: 10px 0 8px 0;
    }
    .progress-fill {
      height: 100%; background: linear-gradient(90deg, #10b981, #3b82f6);
      transition: width 0.25s ease;
    }
    .segments-bar {
      display: flex; gap: 3px; margin-top: 6px;
    }
    .seg-box {
      flex: 1; height: 5px; background: #1e293b; border-radius: 2px; overflow: hidden;
    }
    .seg-fill { height: 100%; background: #38bdf8; }
    .job-actions { display: flex; gap: 6px; margin-top: 10px; }
    .job-actions button { padding: 5px 10px; font-size: 12px; }
    video { width: 100%; border-radius: 8px; background: #000; margin-top: 8px; }
    .empty { text-align: center; color: var(--muted); padding: 32px 12px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">IDM</div>
        <div>
          <h1>Mini-IDM — Serveur Local & Moteur Multi-Segments</h1>
          <div class="sub">Dossier de sortie : <code id="dirPath">...</code></div>
        </div>
      </div>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-secondary" id="openFolderBtn">📁 Ouvrir le dossier Mini-IDM</button>
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <h2>Téléchargements Actifs & Historique</h2>
        <div class="manual-bar">
          <input id="manualUrl" type="text" placeholder="Coller une URL directe (.mp4, .webm) ou un flux HLS (.m3u8)..." />
          <button class="btn" id="manualDownloadBtn">⬇ Télécharger (8 segments)</button>
        </div>
        <div id="jobsList"><div class="empty">Aucun téléchargement pour le moment. Survolez une vidéo dans votre navigateur et cliquez sur « Télécharger cette vidéo » !</div></div>
      </div>

      <div class="card">
        <h2>🎬 Lecteur Vidéo de Test</h2>
        <p style="font-size:13px; color:var(--muted); margin-top:0;">
          Si l'extension <b>Mini-IDM</b> est activée dans Chrome/Edge/Brave, survolez la vidéo ci-dessous : le bouton flottant <b>« Télécharger cette vidéo »</b> apparaîtra automatiquement en haut à droite du lecteur !
        </p>
        <video controls preload="metadata" poster="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg">
          <source src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4" type="video/mp4" />
        </video>
        <div style="margin-top:12px; font-size:12px; color:var(--muted);">
          Flux MP4 direct de démonstration (supporte le découpage HTTP <code>Range</code> en 8 segments simultanés).
        </div>
      </div>
    </div>
  </div>

  <script>
    function fmtBytes(b) {
      if (!b || b <= 0) return '0 B';
      const u = ['B', 'Ko', 'Mo', 'Go'];
      const i = Math.floor(Math.log(b) / Math.log(1024));
      return (b / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + ' ' + u[i];
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function loadStatus() {
      const r = await fetch('/api/status');
      const d = await r.json();
      document.getElementById('dirPath').textContent = d.downloadDir;
    }

    document.getElementById('openFolderBtn').addEventListener('click', async () => {
      await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderOnly: true })
      });
    });

    document.getElementById('manualDownloadBtn').addEventListener('click', async () => {
      const input = document.getElementById('manualUrl');
      const url = input.value.trim();
      if (!url) return;
      input.value = '';
      await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
    });

    // Délégation d'événements sur la liste des téléchargements (insensible aux rafraîchissements SSE)
    document.getElementById('jobsList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'play') {
        await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, revealInFolder: false })
        });
      } else if (action === 'folder') {
        await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, revealInFolder: true })
        });
      } else if (action === 'cancel') {
        await fetch('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, remove: false })
        });
      } else if (action === 'remove') {
        await fetch('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, remove: true })
        });
      }
    });

    function renderJobs(jobs) {
      const el = document.getElementById('jobsList');
      if (!jobs || jobs.length === 0) {
        el.innerHTML = '<div class="empty">Aucun téléchargement pour le moment. Survolez une vidéo dans votre navigateur et cliquez sur « Télécharger cette vidéo » !</div>';
        return;
      }
      el.innerHTML = jobs.map(j => {
        const segHtml = (j.segments && j.segments.length > 1)
          ? '<div class="segments-bar">' + j.segments.map(s => {
              const pct = s.total > 0 ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : 0;
              return '<div class="seg-box" title="Segment #' + (s.index + 1) + ': ' + pct + '%"><div class="seg-fill" style="width:' + pct + '%"></div></div>';
            }).join('') + '</div>'
          : '';

        return '<div class="job">' +
          '<div class="job-top">' +
            '<div class="job-title">' + escapeHtml(j.filename) + '</div>' +
            '<span class="badge ' + escapeHtml(j.status) + '">' + escapeHtml(j.status.toUpperCase()) + '</span>' +
          '</div>' +
          '<div class="job-meta">' +
            '<span>⚡ ' + escapeHtml(j.mode) + '</span>' +
            '<span>📦 ' + fmtBytes(j.downloadedBytes) + (j.totalBytes ? ' / ' + fmtBytes(j.totalBytes) : '') + ' (' + (j.progress || 0) + '%)</span>' +
            (j.speedBps > 0 ? '<span>🚀 ' + fmtBytes(j.speedBps) + '/s</span>' : '') +
            (j.etaSec != null && j.status === 'downloading' ? '<span>⏱ ETA: ' + j.etaSec + 's</span>' : '') +
            (j.error ? '<span style="color:#fca5a5;">❌ ' + escapeHtml(j.error) + '</span>' : '') +
          '</div>' +
          '<div class="progress-bar"><div class="progress-fill" style="width:' + (j.progress || 0) + '%"></div></div>' +
          segHtml +
          '<div class="job-actions">' +
            (j.status === 'completed'
              ? '<button class="btn" data-action="play" data-id="' + escapeHtml(j.id) + '">▶ Lire la vidéo</button>' +
                '<button class="btn btn-secondary" data-action="folder" data-id="' + escapeHtml(j.id) + '">📂 Afficher dans le dossier</button>'
              : '<button class="btn btn-secondary" data-action="cancel" data-id="' + escapeHtml(j.id) + '">⏹ Annuler</button>') +
            '<button class="btn btn-secondary" data-action="remove" data-id="' + escapeHtml(j.id) + '">🗑 Retirer</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    loadStatus();
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'jobs') renderJobs(data.jobs);
    };
  </script>
</body>
</html>`;
}

server.listen(PORT, HOST, () => {
  console.log('==============================================================');
  console.log(` 🚀 Mini-IDM Server actif sur http://${HOST}:${PORT}`);
  console.log(` 📁 Dossier de sortie : ${DEFAULT_DOWNLOAD_DIR}`);
  console.log('==============================================================');
});
