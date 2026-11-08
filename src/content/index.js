// Content script na youtube.com: most do ekstraktora w swiecie strony + przycisk w odtwarzaczu.
import { PlayerButton, errorText } from './button.js';
import { ShortsMenu, isShortsPage, shortsPlayerRect, toast } from './shorts.js';
import { videoIdFromUrl, getSettings } from '../shared/util.js';

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
    const label = mode === 'mp3' ? 'MP3' : `MP4 ${quality}p`;
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

// ---------------------------------------------------------------- autotest (tylko build deweloperski)

if (__DEV__) {
  const m = location.hash.match(/ytdl-autotest=(shorts-)?(mp3|mp4-\d+)/);
  if (m) (m[1] ? runShortsAutotest(m[2]) : runAutotest(m[2]));
}

async function runAutotest(choice) {
  const report = { choice, url: location.href, startedAt: new Date().toISOString(), steps: [] };
  const step = (name, data) => report.steps.push({ name, t: Math.round(performance.now()), ...data });
  const send = () => browser.runtime.sendMessage({ type: 'autotest-report', name: `${currentVideoId()}-${choice}`, report });
  try {
    await sleep(6000); // YouTube w czystym profilu potrafi przeladowac strone (themeRefresh) - nie dubluj testu
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { ok = button.ensure(); if (!ok) await sleep(500); }
    const b = document.querySelector('.ytdl-btn');
    const r = b?.getBoundingClientRect();
    step('przycisk', { found: !!b, prev: b?.previousElementSibling?.className, parent: b?.parentElement?.className, rect: r && { x: r.x, y: r.y, w: r.width, h: r.height } });

    await button.openMenu();
    const items = [...document.querySelectorAll('.ytdl-menu .ytdl-menu-item')].map((x) => x.textContent);
    const mr = document.querySelector('.ytdl-menu')?.getBoundingClientRect();
    step('menu', { items, error: document.querySelector('.ytdl-error-text')?.textContent, rect: mr && { x: mr.x, y: mr.y, w: mr.width, h: mr.height } });
    document.querySelector('video')?.pause();
    const cap = await browser.runtime.sendMessage({ type: 'autotest-capture', name: `${currentVideoId()}-menu` });
    step('zrzut-menu', cap);
    button.closeMenu();

    const [mode, q] = choice === 'mp3' ? ['mp3', null] : ['mp4', choice.split('-')[1]];
    const job = await button.deps.onChoose(mode, q);
    step('kolejka', { job: job?.id, label: job?.label });
    // zrzut przycisku z pierscieniem postepu (paski sterowania wymuszone na widoczne)
    document.querySelector('#movie_player')?.classList.add('ytdl-menu-open');
    await sleep(700);
    step('zrzut-postep', await browser.runtime.sendMessage({ type: 'autotest-capture', name: `${currentVideoId()}-progress` }));
    document.querySelector('#movie_player')?.classList.remove('ytdl-menu-open');
    const final = await new Promise((resolve) => {
      const h = (msg) => {
        if (msg?.type === 'job-update' && msg.job.id === job.id && ['done', 'error', 'cancelled'].includes(msg.job.state)) {
          browser.runtime.onMessage.removeListener(h); resolve(msg.job);
        }
      };
      browser.runtime.onMessage.addListener(h);
    });
    step('koniec', { state: final.state, error: final.error, filename: final.filename, bytes: final.totalBytes });
  } catch (e) {
    step('wyjatek', { error: String(e?.message ?? e) });
  }
  await send();
}

async function runShortsAutotest(choice) {
  const report = { choice: `shorts-${choice}`, url: location.href, startedAt: new Date().toISOString(), steps: [] };
  const step = (name, data) => report.steps.push({ name, t: Math.round(performance.now()), ...data });
  const name = (suffix) => `${currentVideoId()}-shorts-${suffix}`;
  try {
    await sleep(6000);
    let mb = null;
    for (let i = 0; i < 60 && !mb; i++) { mb = document.querySelector('ytd-shorts #menu-button button'); if (!mb) await sleep(500); }
    step('przycisk-menu', { found: !!mb });
    document.querySelector('ytd-shorts video')?.pause();
    mb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    mb.click();
    let item = null;
    for (let i = 0; i < 40 && !item; i++) { item = document.querySelector('.ytdl-shorts-item'); if (!item) await sleep(100); }
    const list = item?.parentElement;
    step('pozycja', { found: !!item, siblings: list ? [...list.children].map((c) => c.textContent.trim().slice(0, 30)) : null, rect: item && JSON.parse(JSON.stringify(item.getBoundingClientRect())) });
    await sleep(400);
    step('zrzut-dropdown', await browser.runtime.sendMessage({ type: 'autotest-capture', name: name('dropdown') }));
    item.click();
    let opts = [];
    for (let i = 0; i < 60 && !opts.length; i++) { opts = [...document.querySelectorAll('.ytdl-menu .ytdl-menu-item')]; if (!opts.length) await sleep(500); }
    const dd = [...document.querySelectorAll('ytd-popup-container tp-yt-iron-dropdown')].some((d) => d.style.display !== 'none');
    step('menu', { items: opts.map((x) => x.textContent), dropdownStillOpen: dd, error: document.querySelector('.ytdl-error-text')?.textContent, rect: JSON.parse(JSON.stringify(document.querySelector('.ytdl-menu')?.getBoundingClientRect() ?? {})) });
    step('zrzut-menu', await browser.runtime.sendMessage({ type: 'autotest-capture', name: name('menu') }));
    const target = opts.find((x) => (choice === 'mp3' ? x.textContent.startsWith('MP3') : x.textContent.startsWith(`${choice.split("-")[1]}p`))) || opts[1];
    target.click();
    await sleep(800);
    step('zrzut-toast', await browser.runtime.sendMessage({ type: 'autotest-capture', name: name('toast') }));
    const final = await new Promise((resolve) => {
      const h = (msg) => {
        if (msg?.type === 'job-update' && ['done', 'error', 'cancelled'].includes(msg.job.state)) { browser.runtime.onMessage.removeListener(h); resolve(msg.job); }
      };
      browser.runtime.onMessage.addListener(h);
    });
    step('koniec', { state: final.state, error: final.error, filename: final.filename, bytes: final.totalBytes });
  } catch (e) {
    step('wyjatek', { error: String(e?.message ?? e), stack: e?.stack });
  }
  await browser.runtime.sendMessage({ type: 'autotest-report', name: name(choice), report });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
