// Tlo wtyczki: kolejka zadan, pobieranie, przetwarzanie, zapis, menu PPM, powiadomienia.
import { downloadStream } from './downloader.js';
import { muxMp4, convertAudio, fetchCover } from './media.js';
import { extractVideo, extractOnTab, releaseEngineTab } from './engine.js';
import { opfsAvailable, createTempFile, clearTempFiles } from './tempfiles.js';
import { pickFormats, sanitizeFilename, videoIdFromUrl, getSettings, isAudioMode, parseChoice, jobLabel, AUDIO_FORMATS } from '../shared/util.js';

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
    label: jobLabel(mode, height), info, formats, tabId, engineTab,
    state: 'queued', stage: 'Queued', progress: 0, bytes: 0, totalBytes: 0, createdAt: Date.now(),
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
  if (job.state === 'queued') update(job, { state: 'cancelled', stage: 'Cancelled', finishedAt: Date.now() });
  controllers.get(id)?.abort();
}

async function runJob(job) {
  const ac = new AbortController();
  controllers.set(job.id, ac);
  const { signal } = ac;
  const settings = await getSettings();
  // pliki tymczasowe na dysku (OPFS) zamiast RAM - konieczne przy 4K/8K; bez OPFS wszystko w pamieci
  const temps = [];
  const useDisk = await opfsAvailable();
  const newTemp = async (label) => {
    if (!useDisk) return undefined;
    const t = await createTempFile(`${job.id}-${label}`);
    temps.push(t);
    return t;
  };
  try {
    const { video, audio, muxed } = job.formats;
    const streams = [muxed, video, audio].filter(Boolean);
    const total = streams.reduce((s, f) => s + (f.size || 0), 0);
    update(job, { state: 'downloading', stage: 'Downloading', totalBytes: total, bytes: 0, progress: 0 });

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
      if (job.tabId == null) throw new Error('The stream URL expired and the YouTube tab is closed');
      const fresh = await extractOnTab(job.tabId, job.videoId);
      const all = [...fresh.videos, ...fresh.audios, ...fresh.muxed];
      const same = all.find((f) => f.itag === fmt.itag);
      if (!same) throw new Error('The same stream is no longer available after refreshing');
      return same.url;
    };
    const dl = async (fmt, label) => downloadStream(fmt, { signal, onBytes, refreshUrl: refreshUrl(fmt), temp: await newTemp(label) });

    let output;
    let ext;
    if (isAudioMode(job.mode)) {
      const fmt = AUDIO_FORMATS[job.mode];
      const [{ blob: audioBlob }, cover] = await Promise.all([dl(audio, 'a'), fetchCover(job.videoId)]);
      update(job, { state: 'processing', stage: fmt.copy ? `Writing ${fmt.label}` : `Converting to ${fmt.label}`, progress: 0.9 });
      const tags = { title: job.title, artist: job.author, ...(cover ? { images: [{ data: cover, mimeType: 'image/jpeg', kind: 'coverFront' }] } : {}) };
      output = await convertAudio(audioBlob, job.mode, {
        bitrate: settings.mp3Bitrate, tags, signal,
        temp: job.mode === 'wav' ? await newTemp('out') : undefined,
        onProgress: (p) => update(job, { progress: 0.9 + p * 0.09 }),
      });
      ext = fmt.ext;
    } else if (muxed) {
      output = (await dl(muxed, 'm')).blob;
      ext = 'mp4';
    } else {
      const [{ blob: v }, { blob: a }] = await Promise.all([dl(video, 'v'), dl(audio, 'a')]);
      update(job, { state: 'processing', stage: 'Merging video and audio', progress: 0.9 });
      output = await muxMp4(v, a, {
        tags: { title: job.title, artist: job.author }, signal,
        temp: await newTemp('out'), estimate: { duration: job.info?.duration, fps: video.fps },
        onProgress: (p) => update(job, { progress: 0.9 + p * 0.09 }),
      });
      ext = 'mp4';
    }

    update(job, { state: 'saving', stage: 'Saving', progress: 0.99 });
    const folder = sanitizeFilename(settings.subfolder || '', 60);
    const filename = `${folder ? `${folder}/` : ''}${sanitizeFilename(job.title)}.${ext}`;
    const downloadId = await saveBlob(output, filename, settings.saveAs);
    update(job, { state: 'done', stage: 'Done', progress: 1, downloadId, filename, finishedAt: Date.now() });
    notify(job, `Downloaded: ${job.title}`, `${job.label} saved to your Downloads folder.`);
  } catch (e) {
    if (e?.name === 'AbortError' || signal.aborted) {
      update(job, { state: 'cancelled', stage: 'Cancelled', finishedAt: Date.now() });
    } else {
      console.error('[ytdl] zadanie nieudane', e);
      update(job, { state: 'error', stage: 'Error', error: String(e?.message ?? e), finishedAt: Date.now() });
      notify(job, 'Download failed', `${job.title}: ${e?.message ?? e}`);
    }
  } finally {
    for (const t of temps) await t.remove();
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
        if (d.state.current === 'interrupted') { browser.downloads.onChanged.removeListener(onChanged); reject(new Error(`Saving was interrupted (${d.error?.current || 'unknown reason'})`)); }
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
  { id: 'm4a', title: 'M4A (original AAC audio)' },
  { id: 'opus', title: 'Opus (original audio, best quality)' },
  { id: 'wav', title: 'WAV (uncompressed audio)' },
  { id: 'sep', type: 'separator' },
  { id: 'mp4-2160', title: 'MP4 4K (VP9/AV1)' },
  { id: 'mp4-1080', title: 'MP4 1080p' },
  { id: 'mp4-720', title: 'MP4 720p' },
  { id: 'mp4-480', title: 'MP4 480p' },
  { id: 'mp4-360', title: 'MP4 360p' },
];
const YT_LINKS = ['*://*.youtube.com/watch*', '*://*.youtube.com/shorts/*', '*://youtu.be/*', '*://*.youtube.com/live/*'];

function createMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'link', title: 'Download from YouTube', contexts: ['link'], targetUrlPatterns: YT_LINKS });
    browser.contextMenus.create({ id: 'page', title: 'Download this video', contexts: ['page', 'video'], documentUrlPatterns: YT_LINKS });
    for (const parent of ['link', 'page']) {
      for (const it of MENU_ITEMS) browser.contextMenus.create({ id: `${parent}:${it.id}`, parentId: parent, type: it.type || 'normal', ...(it.title ? { title: it.title } : {}), contexts: parent === 'link' ? ['link'] : ['page', 'video'] });
    }
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const [, choice] = String(info.menuItemId).split(':');
  if (!choice || choice === 'sep') return;
  const url = info.linkUrl || info.pageUrl;
  const videoId = videoIdFromUrl(url);
  if (!videoId) return;
  const [mode, quality] = parseChoice(choice);
  const onYoutube = /^https?:\/\/www\.youtube\.com\//.test(tab?.url || '');
  enqueueByVideoId(videoId, mode, quality, onYoutube ? tab.id : null).catch((e) => {
    notify({ id: `err-${Date.now()}` }, 'Download failed', String(e?.message ?? e));
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
      if (!videoId) return Promise.resolve({ ok: false, error: 'This does not look like a YouTube video URL' });
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
clearTempFiles(); // resztki po zadaniach przerwanych zamknieciem przegladarki
