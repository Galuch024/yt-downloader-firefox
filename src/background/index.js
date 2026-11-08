// Tlo wtyczki: kolejka zadan, pobieranie, przetwarzanie, zapis, menu PPM, powiadomienia.
import { downloadStream } from './downloader.js';
import { muxMp4, toMp3, fetchCover } from './media.js';
import { extractVideo, extractOnTab, releaseEngineTab } from './engine.js';
import { pickFormats, sanitizeFilename, videoIdFromUrl, getSettings } from '../shared/util.js';

/** @type {Map<string, any>} */
const jobs = new Map();
const controllers = new Map();
const popupPorts = new Set();
let running = 0;

const publicJob = (j) => ({
  id: j.id, videoId: j.videoId, title: j.title, author: j.author, mode: j.mode, quality: j.quality,
  label: j.label, state: j.state, stage: j.stage, progress: j.progress, error: j.error,
  bytes: j.bytes, totalBytes: j.totalBytes, downloadId: j.downloadId, filename: j.filename,
  createdAt: j.createdAt, finishedAt: j.finishedAt,
});

function update(job, patch) {
  Object.assign(job, patch);
  const pj = publicJob(job);
  for (const p of popupPorts) { try { p.postMessage({ type: 'job', job: pj }); } catch { /* port zamkniety */ } }
  if (job.tabId != null) browser.tabs.sendMessage(job.tabId, { type: 'job-update', job: pj }).catch(() => {});
  if (['done', 'error', 'cancelled'].includes(job.state)) persistHistory();
}

let persistTimer = null;
function persistHistory() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const list = [...jobs.values()].filter((j) => ['done', 'error', 'cancelled'].includes(j.state))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(publicJob);
    browser.storage.local.set({ history: list }).catch(() => {});
  }, 300);
}

async function loadHistory() {
  const { history = [] } = await browser.storage.local.get('history').catch(() => ({}));
  for (const j of history) if (!jobs.has(j.id)) jobs.set(j.id, { ...j });
}

// ---------------------------------------------------------------- kolejka

/**
 * Dodaje zadanie. info = wynik ekstrakcji (z content scriptu lub z engine.extractVideo).
 * tabId = karta, ktora moze odswiezyc wygasle adresy i ktora dostaje aktualizacje postepu.
 */
function enqueue({ info, mode, quality, tabId, engineTab = false }) {
  const formats = pickFormats(info, mode, quality); // rzuca, jesli brak formatow
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const height = formats.video?.height || formats.muxed?.height;
  const job = {
    id, videoId: info.videoId, title: info.title, author: info.author, mode, quality: height ? String(height) : null,
    label: mode === 'mp3' ? 'MP3' : `MP4 ${height}p`, info, formats, tabId, engineTab,
    state: 'queued', stage: 'W kolejce', progress: 0, bytes: 0, totalBytes: 0, createdAt: Date.now(),
  };
  jobs.set(id, job);
  update(job, {});
  pump();
  return publicJob(job);
}

async function pump() {
  const { concurrency } = await getSettings();
  for (const job of jobs.values()) {
    if (running >= concurrency) break;
    if (job.state !== 'queued') continue;
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.state === 'queued') update(job, { state: 'cancelled', stage: 'Anulowano', finishedAt: Date.now() });
  controllers.get(id)?.abort();
}

async function runJob(job) {
  const ac = new AbortController();
  controllers.set(job.id, ac);
  const { signal } = ac;
  const settings = await getSettings();
  try {
    const { video, audio, muxed } = job.formats;
    const streams = [muxed, video, audio].filter(Boolean);
    const total = streams.reduce((s, f) => s + (f.size || 0), 0);
    update(job, { state: 'downloading', stage: 'Pobieranie', totalBytes: total, bytes: 0, progress: 0 });

    let bytes = 0;
    let lastEmit = 0;
    const onBytes = (n) => {
      bytes += n;
      const now = Date.now();
      if (now - lastEmit > 250 || bytes >= total) {
        lastEmit = now;
        update(job, { bytes, progress: total ? Math.min(0.9, (bytes / total) * 0.9) : 0 });
      }
    };
    const refreshUrl = (fmt) => async () => {
      if (job.tabId == null) throw new Error('Adres strumienia wygasl, a karta YouTube jest zamknieta');
      const fresh = await extractOnTab(job.tabId, job.videoId);
      const all = [...fresh.videos, ...fresh.audios, ...fresh.muxed];
      const same = all.find((f) => f.itag === fmt.itag);
      if (!same) throw new Error('Po odswiezeniu brak tego samego strumienia');
      return same.url;
    };
    const dl = (fmt) => downloadStream(fmt, { signal, onBytes, refreshUrl: refreshUrl(fmt) });

    let output;
    let ext;
    if (job.mode === 'mp3') {
      const [{ blob: audioBlob }, cover] = await Promise.all([dl(audio), fetchCover(job.videoId)]);
      update(job, { state: 'processing', stage: 'Konwersja do MP3', progress: 0.9 });
      const tags = { title: job.title, artist: job.author, ...(cover ? { images: [{ data: cover, mimeType: 'image/jpeg', kind: 'coverFront' }] } : {}) };
      output = await toMp3(audioBlob, {
        bitrate: settings.mp3Bitrate, tags, signal,
        onProgress: (p) => update(job, { progress: 0.9 + p * 0.09 }),
      });
      ext = 'mp3';
    } else if (muxed) {
      output = (await dl(muxed)).blob;
      ext = 'mp4';
    } else {
      const [{ blob: v }, { blob: a }] = await Promise.all([dl(video), dl(audio)]);
      update(job, { state: 'processing', stage: 'Laczenie obrazu i dzwieku', progress: 0.9 });
      output = await muxMp4(v, a, {
        tags: { title: job.title, artist: job.author }, signal,
        onProgress: (p) => update(job, { progress: 0.9 + p * 0.09 }),
      });
      ext = 'mp4';
    }

    update(job, { state: 'saving', stage: 'Zapisywanie', progress: 0.99 });
    const folder = sanitizeFilename(settings.subfolder || '', 60);
    const filename = `${folder ? `${folder}/` : ''}${sanitizeFilename(job.title)}.${ext}`;
    const downloadId = await saveBlob(output, filename, settings.saveAs);
    update(job, { state: 'done', stage: 'Gotowe', progress: 1, downloadId, filename, finishedAt: Date.now() });
    notify(job, `Pobrano: ${job.title}`, `${job.label} zapisano w folderze Pobrane.`);
  } catch (e) {
    if (e?.name === 'AbortError' || signal.aborted) {
      update(job, { state: 'cancelled', stage: 'Anulowano', finishedAt: Date.now() });
    } else {
      console.error('[ytdl] zadanie nieudane', e);
      update(job, { state: 'error', stage: 'Blad', error: String(e?.message ?? e), finishedAt: Date.now() });
      notify(job, 'Pobieranie nieudane', `${job.title}: ${e?.message ?? e}`);
    }
  } finally {
    controllers.delete(job.id);
    job.formats = null; // zwolnienie adresow; info zostaje do ponowienia
    if (job.engineTab) releaseEngineTab(job.tabId);
  }
}

async function saveBlob(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await browser.downloads.download({ url, filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
    await new Promise((resolve, reject) => {
      const onChanged = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete') { browser.downloads.onChanged.removeListener(onChanged); resolve(); }
        if (d.state.current === 'interrupted') { browser.downloads.onChanged.removeListener(onChanged); reject(new Error(`Zapis przerwany (${d.error?.current || 'nieznany powod'})`)); }
      };
      browser.downloads.onChanged.addListener(onChanged);
    });
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// ---------------------------------------------------------------- powiadomienia

const notifToJob = new Map();
function notify(job, title, message) {
  const nid = `ytdl-${job.id}`;
  notifToJob.set(nid, job.id);
  browser.notifications.create(nid, { type: 'basic', iconUrl: browser.runtime.getURL('icons/icon.svg'), title, message }).catch(() => {});
}
browser.notifications.onClicked.addListener((nid) => {
  const job = jobs.get(notifToJob.get(nid));
  if (job?.downloadId != null) browser.downloads.show(job.downloadId).catch(() => {});
});

// ---------------------------------------------------------------- menu PPM

const MENU_ITEMS = [
  { id: 'mp3', title: 'MP3 (audio)' },
  { id: 'mp4-1080', title: 'MP4 1080p' },
  { id: 'mp4-720', title: 'MP4 720p' },
  { id: 'mp4-480', title: 'MP4 480p' },
  { id: 'mp4-360', title: 'MP4 360p' },
];
const YT_LINKS = ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*', '*://youtu.be/*', '*://*.youtube.com/live/*'];

function createMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'link', title: 'Pobierz z YouTube', contexts: ['link'], targetUrlPatterns: YT_LINKS });
    browser.contextMenus.create({ id: 'page', title: 'Pobierz ten film', contexts: ['page', 'video'], documentUrlPatterns: YT_LINKS });
    for (const parent of ['link', 'page']) {
      for (const it of MENU_ITEMS) browser.contextMenus.create({ id: `${parent}:${it.id}`, parentId: parent, title: it.title, contexts: parent === 'link' ? ['link'] : ['page', 'video'] });
    }
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const [, choice] = String(info.menuItemId).split(':');
  if (!choice) return;
  const url = info.linkUrl || info.pageUrl;
  const videoId = videoIdFromUrl(url);
  if (!videoId) return;
  const [mode, quality] = choice === 'mp3' ? ['mp3', null] : ['mp4', choice.split('-')[1]];
  const onYoutube = /^https?:\/\/www\.youtube\.com\//.test(tab?.url || '');
  enqueueByVideoId(videoId, mode, quality, onYoutube ? tab.id : null).catch((e) => {
    notify({ id: `err-${Date.now()}` }, 'Pobieranie nieudane', String(e?.message ?? e));
  });
});

async function enqueueByVideoId(videoId, mode, quality, preferTabId) {
  const { info, tabId, engine } = await extractVideo(videoId, preferTabId);
  try {
    return enqueue({ info, mode, quality, tabId, engineTab: engine });
  } catch (e) {
    if (engine) releaseEngineTab(tabId);
    throw e;
  }
}

// ---------------------------------------------------------------- komunikaty

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.type) {
    case 'enqueue': {
      // z content scriptu (przycisk w odtwarzaczu) lub z popupu z gotowym info
      try {
        const tabId = msg.tabId ?? sender.tab?.id ?? null;
        return Promise.resolve({ ok: true, job: enqueue({ info: msg.info, mode: msg.mode, quality: msg.quality, tabId }) });
      } catch (e) { return Promise.resolve({ ok: false, error: String(e?.message ?? e) }); }
    }
    case 'enqueue-url': {
      const videoId = videoIdFromUrl(msg.url);
      if (!videoId) return Promise.resolve({ ok: false, error: 'To nie wyglada na adres filmu YouTube' });
      return enqueueByVideoId(videoId, msg.mode, msg.quality, null)
        .then((job) => ({ ok: true, job }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
    }
    case 'cancel': cancelJob(msg.id); return Promise.resolve({ ok: true });
    case 'jobs-for-video':
      return Promise.resolve([...jobs.values()].filter((j) => j.videoId === msg.videoId).map(publicJob));
    case 'show-download': {
      const job = jobs.get(msg.id);
      if (job?.downloadId != null) browser.downloads.show(job.downloadId).catch(() => {});
      return Promise.resolve({ ok: true });
    }
    case 'clear-history':
      for (const [id, j] of jobs) if (['done', 'error', 'cancelled'].includes(j.state)) jobs.delete(id);
      persistHistory();
      return Promise.resolve({ ok: true });
    case 'autotest-capture':
      if (__DEV__) {
        return browser.tabs.update(sender.tab.id, { active: true })
          .then(() => new Promise((r) => setTimeout(r, 400)))
          .then(() => browser.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }))
          .then((dataUrl) => fetch(dataUrl).then((r) => r.blob()))
          .then((blob) => saveBlob(blob, `ytdl-autotest/${msg.name}.png`, false))
          .then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e) }));
      }
      return undefined;
    case 'autotest-report':
      if (__DEV__) return saveBlob(new Blob([JSON.stringify(msg.report, null, 2)], { type: 'application/json' }), `ytdl-autotest/${msg.name}.json`, false).then(() => ({ ok: true }));
      return undefined;
    default:
      return undefined;
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.add(port);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
  port.postMessage({ type: 'state', jobs: list });
});

// Zadania z zamknietej karty nie dostaja juz aktualizacji, ale dzialaja dalej.
browser.tabs.onRemoved.addListener((tabId) => {
  for (const j of jobs.values()) if (j.tabId === tabId && !j.engineTab) j.tabId = null;
});

createMenus();
loadHistory();

if (__DEV__) {
  fetch(browser.runtime.getURL('autotest.json')).then((r) => (r.ok ? r.json() : null)).then(async (urls) => {
    if (!urls?.length) return;
    // odrzucenie niepotrzebnych ciasteczek (SOCS=CAI), zeby baner zgod nie zaslanial odtwarzacza w czystym profilu
    await browser.cookies.set({ url: 'https://www.youtube.com', domain: '.youtube.com', name: 'SOCS', value: 'CAI', secure: true, expirationDate: Date.now() / 1000 + 86400 * 30 }).catch(() => {});
    for (const url of urls) await browser.tabs.create({ url, active: true });
  }).catch(() => {});
}
