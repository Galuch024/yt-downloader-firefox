// Content script na youtube.com: most do ekstraktora w swiecie strony + przycisk w odtwarzaczu.
import { PlayerButton, errorText } from './button.js';
import { ShortsMenu, isShortsPage, shortsPlayerRect, toast } from './shorts.js';
import { videoIdFromUrl, getSettings, parseChoice, jobLabel, AUDIO_FORMATS } from '../shared/util.js';

const CHANNEL = crypto.randomUUID();
const INFO_TTL = 20 * 60 * 1000;
let resolveReady;
const pageReady = new Promise((r) => { resolveReady = r; });
const pending = new Map();
const infoCache = new Map(); // videoId -> { promise, time }

// ---------------------------------------------------------------- most do page.js

function injectPage() {
  const s = document.createElement('script');
  s.src = browser.runtime.getURL('page.js');
  s.dataset.channel = CHANNEL;
  (document.head || document.documentElement).append(s);
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || typeof ev.data !== 'string' || !ev.data.includes('ytdl-page')) return;
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.source !== 'ytdl-page' || msg.channel !== CHANNEL) return;
  if (msg.type === 'ready') { resolveReady(); return; }
  const p = pending.get(msg.reqId);
  if (p) { pending.delete(msg.reqId); p(msg); }
});

async function extractRaw(videoId) {
  await Promise.race([pageReady, sleep(15000).then(() => { throw new Error('The extractor did not start - refresh the page'); })]);
  const reqId = crypto.randomUUID();
  const reply = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(reqId); reject(new Error('Timed out waiting for video information')); }, 90_000);
    pending.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    window.postMessage(JSON.stringify({ source: 'ytdl-cs', channel: CHANNEL, type: 'extract', reqId, videoId }), '*');
  });
  if (!reply.ok) {
    const e = new Error(reply.error?.message || 'Extraction failed');
    e.code = reply.error?.code;
    throw e;
  }
  return reply.result;
}

function loadInfo(videoId, { fresh = false } = {}) {
  const c = infoCache.get(videoId);
  if (!fresh && c && Date.now() - c.time < INFO_TTL) return c.promise;
  const promise = extractRaw(videoId);
  infoCache.set(videoId, { promise, time: Date.now() });
  promise.catch(() => infoCache.delete(videoId));
  return promise;
}

// ---------------------------------------------------------------- przycisk w odtwarzaczu

const isWatchPage = () => location.pathname === '/watch';
const currentVideoId = () => (isWatchPage() || isShortsPage() ? videoIdFromUrl(location.href) : null);
const ACTIVE = ['queued', 'downloading', 'processing', 'saving'];

const button = new PlayerButton({
  getVideoId: currentVideoId,
  loadInfo: (id) => loadInfo(id),
  invalidate: (id) => infoCache.delete(id),
  getSettings,
  onChoose: async (mode, quality) => {
    const videoId = currentVideoId();
    if (!videoId) return;
    const label = jobLabel(mode, quality);
    button.onJob({ videoId, state: 'queued', stage: 'Preparing', progress: 0, label });
    const info = await loadInfo(videoId);
    const r = await browser.runtime.sendMessage({ type: 'enqueue', info, mode, quality });
    if (!r?.ok) throw new Error(r?.error || 'Could not add the download');
    button.onJob(r.job);
    if (isShortsPage()) toast(`Download started: ${label}`);
    return r.job;
  },
  // na Shorts nie ma przycisku z pierscieniem postepu - informujemy toastem
  onFlash: (job) => {
    if (!isShortsPage()) return;
    if (job.state === 'done') toast(`Downloaded ${job.label || ''}`.trim());
    else if (job.state === 'error') toast(`Download failed: ${job.error}`, 'error');
  },
});

// ---------------------------------------------------------------- Shorts: pozycja w menu ⋮

const shorts = new ShortsMenu({
  label: () => {
    const j = button.job;
    if (j && ACTIVE.includes(j.state)) {
      const pct = j.state === 'downloading' ? ` ${Math.round((j.progress || 0) * 100)}%` : '';
      return { title: 'Download (MP3 / MP4)', secondary: `${j.stage}${pct}` };
    }
    return { title: 'Download (MP3 / MP4)' };
  },
  onActivate: (anchor) => button.openMenu({ anchor, placement: 'below', fallbackRect: shortsPlayerRect }),
});
shorts.start();

let lastVideoId = null;
async function tick() {
  const id = currentVideoId();
  if (!id) { button.closeMenu(); return; }
  if (isWatchPage()) button.ensure();
  if (id !== lastVideoId) {
    lastVideoId = id;
    button.reset();
    // stan trwajacych pobran tego filmu (np. po odswiezeniu strony)
    const list = await browser.runtime.sendMessage({ type: 'jobs-for-video', videoId: id }).catch(() => []);
    const active = list?.find((j) => ACTIVE.includes(j.state));
    if (active) button.onJob(active);
  }
}

document.addEventListener('yt-navigate-finish', () => tick());
setInterval(tick, 1000);

// ---------------------------------------------------------------- wiadomosci z tla i popupu

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case 'ping': return Promise.resolve({ pong: true, videoId: currentVideoId() });
    case 'extract':
      return loadInfo(msg.videoId, { fresh: !!msg.fresh })
        .then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: { code: e.code, message: errorText(e) } }));
    case 'job-update': button.onJob(msg.job); return undefined;
    default: return undefined;
  }
});

injectPage();
tick();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
