// Ekstraktor uruchamiany w SWIECIE STRONY youtube.com (wstrzykiwany przez content script).
// Etap 0 wykazal: BotGuard/minter tokenow PO dziala tylko tutaj, a dzialajacy klient to TV_SIMPLY + token PO.
import { Innertube, Platform, UniversalCache } from 'youtubei.js/web';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const CLIENTS = ['TV_SIMPLY']; // kolejne klienty mozna dopisac, jesli YouTube cos zmieni
const MAX_HEIGHT = 1080; // H.264 (avc1) - YouTube nie wydaje go powyzej 1080p
const MAX_HD_HEIGHT = 4320; // powyzej 1080p: VP9 lub AV1 (do 8K)

const self = document.currentScript;
const CHANNEL = self?.dataset.channel;
self?.remove();

// --- eval przez Trusted Types (YouTube wymusza TT) ---
let policy = null;
try { policy = window.trustedTypes?.createPolicy('ytdl-eval', { createScript: (s) => s }); } catch { /* polityka moze juz istniec */ }
const indirectEval = eval;
const wrap = (code) => (policy ? policy.createScript(code) : code);
const evalScript = (code) => { indirectEval(wrap(code)); };
Platform.shim.eval = (data) => indirectEval(wrap(`(function(){${data.output}\n})()`));

const makeFetch = (credentials) => {
  const f = window.fetch.bind(window);
  return (input, init) => f(input, { ...(init || {}), credentials });
};

// --- sesje (osobno bez ciasteczek i z ciasteczkami - dla filmow wymagajacych logowania) ---
const sessions = new Map();

async function createMinter(fetchFn) {
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetchFn });
  const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js) throw new Error('BotGuard: brak interpretera');
  evalScript(js);
  const client = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: window });
  const webPoSignalOutput = [];
  const bgResponse = await client.snapshot({ webPoSignalOutput });
  const r = await fetchFn(buildURL('GenerateIT', true), { method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, bgResponse]) });
  if (!r.ok) throw new Error(`BotGuard: GenerateIT HTTP ${r.status}`);
  const [integrityToken, estimatedTtlSecs] = await r.json();
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  return { minter, ttl: Number(estimatedTtlSecs) || 3600 };
}

async function getSession(withCookies) {
  const key = withCookies ? 'cookies' : 'anon';
  const cached = sessions.get(key);
  if (cached && Date.now() < cached.expires) return cached.promise;
  const promise = (async () => {
    const fetchFn = makeFetch(withCookies ? 'include' : 'omit');
    const yt0 = await Innertube.create({ fetch: fetchFn, retrieve_player: true, cache: new UniversalCache(false) });
    const visitorData = yt0.session.context.client.visitorData;
    const { minter, ttl } = await createMinter(makeFetch('omit'));
    const sessionPot = await minter.mintAsWebsafeString(visitorData);
    const yt = await Innertube.create({
      fetch: fetchFn, retrieve_player: true, cache: new UniversalCache(false),
      visitor_data: visitorData, po_token: sessionPot,
    });
    sessions.get(key).expires = Date.now() + Math.min(ttl, 6 * 3600) * 1000 - 60_000;
    return { yt, minter };
  })();
  sessions.set(key, { promise, expires: Date.now() + 60_000 });
  promise.catch(() => sessions.delete(key));
  return promise;
}

// --- ekstrakcja ---
class ExtractError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function bestThumbnail(info) {
  const t = info.basic_info.thumbnail ?? [];
  return [...t].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
}

async function probe(url, size) {
  const mid = Math.max(0, Math.floor((size || 2_000_000) / 2));
  try {
    const r = await fetch(`${url}&range=${mid}-${mid + 1023}`, { credentials: 'omit' });
    await r.arrayBuffer();
    return r.status;
  } catch { return 0; }
}

async function extractWith(videoId, withCookies) {
  const { yt, minter } = await getSession(withCookies);
  const contentPot = await minter.mintAsWebsafeString(videoId);
  let lastError = new ExtractError('UNKNOWN', 'Could not get video information');

  for (const client of CLIENTS) {
    let info;
    try { info = await yt.getBasicInfo(videoId, { client, po_token: contentPot }); }
    catch (e) { lastError = new ExtractError('UNKNOWN', String(e?.message ?? e)); continue; }

    const ps = info.playability_status;
    if (ps?.status !== 'OK') {
      const code = ps?.status === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : ps?.status === 'LIVE_STREAM_OFFLINE' ? 'LIVE' : 'UNPLAYABLE';
      lastError = new ExtractError(code, ps?.reason || `Film niedostepny (${ps?.status})`);
      continue;
    }
    if (info.basic_info.is_live) throw new ExtractError('LIVE', 'Live streams cannot be downloaded');

    const sd = info.streaming_data;
    const adaptive = sd?.adaptive_formats ?? [];
    if (!adaptive.some((f) => f.url || f.signature_cipher || f.cipher)) {
      lastError = new ExtractError('NO_URLS', `Client ${client} returned no stream URLs`);
      continue;
    }

    const player = yt.session.player;
    // "jakosc" = krotszy bok klatki (pionowe Shorts 1080x1920 to 1080p, nie 1920p)
    const qual = (f) => (f.width && f.height ? Math.min(f.width, f.height) : f.height || 0);
    const codecOf = (f) => (f.mime_type.includes('avc1') ? 'h264' : f.mime_type.includes('av01') ? 'av1' : f.mime_type.includes('vp9') || f.mime_type.includes('vp09') ? 'vp9' : 'other');
    const toEntry = async (f) => ({
      itag: f.itag, mime: f.mime_type, bitrate: f.bitrate || 0, size: Number(f.content_length) || 0,
      height: qual(f), fps: f.fps || 0, codec: f.has_video ? codecOf(f) : undefined, url: await f.decipher(player),
    });
    // HDR (PQ/HLG) na zwyklym ekranie wyglada na wyprane - bierzemy tylko SDR
    const isHdr = (f) => /HDR/i.test(f.quality_label || '') || /SMPTEST2084|ARIB_STD_B67|2084|HLG/i.test(f.color_info?.transfer_characteristics || '');
    const better = (f, cur) => !cur || (f.fps || 0) > (cur.fps || 0) || ((f.fps || 0) === (cur.fps || 0) && f.bitrate > cur.bitrate);

    // wideo H.264 bez dzwieku: najlepszy format na kazda wysokosc
    const byHeight = new Map();
    for (const f of adaptive) {
      const q = qual(f);
      if (!f.has_video || f.has_audio || !f.mime_type.includes('avc1') || !q || q > MAX_HEIGHT) continue;
      const cur = byHeight.get(q);
      if (better(f, cur)) byHeight.set(q, f);
    }

    // powyzej 1080p tylko VP9/AV1. Preferujemy VP9 (lepsza zgodnosc odtwarzaczy, lzejszy dekoding 4K);
    // AV1 tylko gdy VP9 nie ma (np. 8K), albo ma wyraznie wiecej klatek.
    const hdByHeight = new Map();
    for (const f of adaptive) {
      const q = qual(f);
      if (!f.has_video || f.has_audio || q <= MAX_HEIGHT || q > MAX_HD_HEIGHT || isHdr(f)) continue;
      const c = codecOf(f);
      if (c !== 'vp9' && c !== 'av1') continue;
      const cur = hdByHeight.get(q);
      if (!cur) { hdByHeight.set(q, f); continue; }
      const cc = codecOf(cur);
      if (c === cc) { if (better(f, cur)) hdByHeight.set(q, f); }
      else if (c === 'vp9' ? (f.fps || 0) >= (cur.fps || 0) : (f.fps || 0) > (cur.fps || 0)) hdByHeight.set(q, f);
    }
    const videos = await Promise.all([...byHeight.values()].map(toEntry));
    let hdVideos = await Promise.all([...hdByHeight.values()].map(toEntry));

    // audio: najlepsze AAC (mp4a) i najlepsze Opus
    // oryginalna sciezka (nie dubbing/auto-dubbing) i bez "stabilnej glosnosci" (DRC) maja pierwszenstwo
    const audioRank = (f) => (f.is_auto_dubbed || f.is_dubbed ? 2 : 0) + (f.is_drc ? 1 : 0);
    const pickAudio = (codec) => adaptive.filter((f) => f.has_audio && !f.has_video && f.mime_type.includes(codec))
      .sort((a, b) => audioRank(a) - audioRank(b) || b.bitrate - a.bitrate)[0];
    const audios = await Promise.all([pickAudio('mp4a'), pickAudio('opus')].filter(Boolean).map(toEntry));

    // strumien z gotowym dzwiekiem (np. itag 18, 360p)
    const muxedRaw = (sd.formats ?? []).filter((f) => f.has_video && f.has_audio && f.mime_type.includes('mp4')).sort((a, b) => qual(b) - qual(a));
    const muxed = await Promise.all(muxedRaw.slice(0, 1).map(toEntry));

    // kontrola: srodek pliku musi dac 200 (bez tokenu PO YouTube odcina po kilku MB)
    const check = videos[0] || audios[0];
    if (check) {
      const st = await probe(check.url, check.size);
      if (st !== 200 && st !== 206) { lastError = new ExtractError('BLOCKED', `Server rejected the stream (HTTP ${st}) for client ${client}`); continue; }
    }
    // formaty >1080p sprawdzamy osobno - jesli serwer ich nie wyda, po prostu ich nie pokazujemy
    if (hdVideos.length) {
      const top = [...hdVideos].sort((a, b) => b.height - a.height)[0];
      const st = await probe(top.url, top.size);
      if (st !== 200 && st !== 206) hdVideos = [];
    }

    return {
      videoId,
      title: info.basic_info.title || videoId,
      author: info.basic_info.author || '',
      duration: info.basic_info.duration || 0,
      thumbnail: bestThumbnail(info),
      client,
      videos: [...videos, ...hdVideos], audios, muxed,
      fetchedAt: Date.now(),
    };
  }
  throw lastError;
}

async function extract(videoId) {
  try {
    return await extractWith(videoId, false);
  } catch (e) {
    if (e.code === 'LOGIN_REQUIRED' || e.code === 'UNPLAYABLE') return extractWith(videoId, true);
    throw e;
  }
}

// --- komunikacja z content scriptem (JSON, zeby ominac wrappery Xray) ---
window.addEventListener('message', async (ev) => {
  if (ev.source !== window || typeof ev.data !== 'string') return;
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.source !== 'ytdl-cs' || msg.channel !== CHANNEL || msg.type !== 'extract') return;
  let reply;
  try { reply = { ok: true, result: await extract(msg.videoId) }; }
  catch (e) { reply = { ok: false, error: { code: e.code || 'UNKNOWN', message: String(e?.message ?? e) } }; }
  window.postMessage(JSON.stringify({ source: 'ytdl-page', channel: CHANNEL, reqId: msg.reqId, ...reply }), '*');
});

window.postMessage(JSON.stringify({ source: 'ytdl-page', channel: CHANNEL, type: 'ready' }), '*');
