// Tlo prototypu: steruje testem, pobiera strumienie w calosci, scala MP4, robi MP3, zapisuje wyniki.
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { muxMp4, toMp3, canEncodeAudio } from './media.js';

const EXTRACT_VIDEOS = ['j6fSJCIoqLo', 'WXuK6gekU1Y'];   // 9 min (pelne pobranie) + 90 min (tylko zakresy)
const FULL_DOWNLOAD_VIDEO = 'j6fSJCIoqLo';
const CHUNK = 10 * 1024 * 1024, PARALLEL = 4;

const summary = { started: new Date().toISOString(), extract: {}, full: null, media: null };
let resultsForVideo = [];
let finishedResolve = null;

async function save(name, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type });
  const url = URL.createObjectURL(blob);
  const id = await browser.downloads.download({ url, filename: `ytdl-spike/${name}`, conflictAction: 'overwrite', saveAs: false });
  await new Promise((res) => {
    const h = (d) => { if (d.id === id && d.state && d.state.current !== 'in_progress') { browser.downloads.onChanged.removeListener(h); res(); } };
    browser.downloads.onChanged.addListener(h);
  });
  URL.revokeObjectURL(url);
}

const slim = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'url' || k === 'audioUrl' ? (v ? '(jest)' : v) : v)));

browser.runtime.onMessage.addListener((m) => {
  if (m.type === 'extract-result') resultsForVideo.push(m.result);
  if (m.type === 'extract-finished') finishedResolve?.();
});

async function extractOn(videoId) {
  resultsForVideo = [];
  const done = new Promise((res) => { finishedResolve = res; });
  const tab = await browser.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}#ytdl-spike`, active: true });
  await Promise.race([done, new Promise((res) => setTimeout(res, 300_000))]);
  await browser.tabs.remove(tab.id).catch(() => {});
  return resultsForVideo;
}

async function downloadAll(url, size, onProgress) {
  const chunks = [];
  for (let s = 0; s < size; s += CHUNK) chunks.push([s, Math.min(s + CHUNK, size) - 1]);
  const parts = new Array(chunks.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      const [a, b] = chunks[i];
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(`${url}&range=${a}-${b}`, { credentials: 'omit' });
        if (r.ok) { parts[i] = await r.blob(); break; }
        if (attempt >= 3) throw new Error(`HTTP ${r.status} na ${a}-${b} (kawalek ${i + 1}/${chunks.length})`);
        await new Promise((res) => setTimeout(res, 700 * attempt));
      }
      done += parts[i].size;
      onProgress?.(done / size);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return new Blob(parts);
}

function pickWorking(results) {
  // pierwszy wariant (swiat + klient), w ktorym poczatek/srodek/koniec daja 200
  for (const r of results) for (const [key, c] of Object.entries(r.clients ?? {}))
    if (c.ranges === '200/200/200' && c.url && c.audioUrl) return { world: r.label, key, c };
  return null;
}

async function run() {
  // Odrzucenie zgod na niepotrzebne ciasteczka YouTube (SOCS=CAI), zeby w UE nie bylo przekierowania na consent.youtube.com
  await browser.cookies.set({ url: 'https://www.youtube.com', domain: '.youtube.com', name: 'SOCS', value: 'CAI', secure: true, expirationDate: Date.now() / 1000 + 86400 * 30 }).catch(() => {});

  let working = null, workingVideo = null;
  for (const id of EXTRACT_VIDEOS) {
    const results = await extractOn(id);
    summary.extract[id] = results.map(slim);
    await save(`extract-${id}.json`, summary.extract[id]);
    if (id === FULL_DOWNLOAD_VIDEO) { working = pickWorking(results); workingVideo = id; }
  }

  if (working) {
    const t = performance.now();
    try {
      const [v, a] = await Promise.all([downloadAll(working.c.url, working.c.size), downloadAll(working.c.audioUrl, working.c.audioSize)]);
      const sec = (performance.now() - t) / 1000;
      summary.full = { ok: true, via: `${working.world} / ${working.key}`, videoMB: +(v.size / 1048576).toFixed(1), audioMB: +(a.size / 1048576).toFixed(1), sec: +sec.toFixed(1), MBps: +((v.size + a.size) / 1048576 / sec).toFixed(1) };
      summary.media = await mediaTest(workingVideo, v, a);
    } catch (e) {
      summary.full = { ok: false, via: `${working.world} / ${working.key}`, error: String(e.message ?? e) };
    }
  } else {
    summary.full = { ok: false, error: 'zaden wariant nie dal 200/200/200 dla ' + FULL_DOWNLOAD_VIDEO };
  }
  summary.finished = new Date().toISOString();
  await save('summary.json', summary);
  await save('DONE.txt', 'ok', 'text/plain');
}

async function mediaTest(videoId, videoBlob, audioBlob) {
  const out = {};
  let cover = null;
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
    if (r.ok) cover = new Uint8Array(await r.arrayBuffer());
  } catch {}
  const tags = { title: 'Test etapu 0', artist: 'YouTube', ...(cover ? { images: [{ data: cover, mimeType: 'image/jpeg', kind: 'coverFront' }] } : {}) };

  try {
    const t = performance.now();
    const m = await muxMp4(videoBlob, audioBlob, { title: tags.title });
    out.mp4 = { ok: true, MB: +(m.buffer.byteLength / 1048576).toFixed(1), codecs: `${m.videoCodec}+${m.audioCodec}`, sec: +((performance.now() - t) / 1000).toFixed(2) };
    const blob = new Blob([m.buffer], { type: 'video/mp4' });
    out.mp4.playable = await checkPlayable(blob, 'video');
    await save(`${videoId}.mp4`, blob);
  } catch (e) { out.mp4 = { ok: false, error: String(e.message ?? e) }; }

  try {
    out.nativeMp3 = await canEncodeAudio('mp3');
    if (!out.nativeMp3) registerMp3Encoder();
    const t = performance.now();
    const buf = await toMp3(audioBlob, { bitrate: 192_000, tags });
    out.mp3 = { ok: true, MB: +(buf.byteLength / 1048576).toFixed(1), sec: +((performance.now() - t) / 1000).toFixed(2), cover: !!cover };
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    out.mp3.playable = await checkPlayable(blob, 'audio');
    await save(`${videoId}.mp3`, blob);
  } catch (e) { out.mp3 = { ok: false, error: `${e?.name}: ${e?.message ?? e} | ${String(e?.stack ?? '').slice(0, 400)}` }; }
  return out;
}

function checkPlayable(blob, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(blob);
    const end = (v) => { URL.revokeObjectURL(url); resolve(v); };
    el.onloadedmetadata = () => end({ duration: Math.round(el.duration), ...(kind === 'video' ? { w: el.videoWidth, h: el.videoHeight } : {}) });
    el.onerror = () => end({ error: el.error?.message || 'media error ' + el.error?.code });
    setTimeout(() => end({ error: 'timeout' }), 15000);
    el.preload = 'metadata';
    el.src = url;
  });
}

run().catch((e) => save('summary.json', { ...summary, fatal: String(e.stack ?? e) }).then(() => save('DONE.txt', 'fatal', 'text/plain')));
