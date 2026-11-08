// Etap 0: test ekstrakcji w przegladarce. Uruchamiany w dwoch "swiatach":
// content script (piaskownica rozszerzenia) i swiat strony youtube.com.
import { Innertube, Platform, UniversalCache } from 'youtubei.js/web';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders } from 'bgutils-js/utils';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const MB = 1024 * 1024;

const msg = (e) => String(e?.message ?? e).slice(0, 300);

async function step(log, name, fn) {
  const t = performance.now();
  try {
    const value = await fn();
    log.push({ step: name, ok: true, ms: Math.round(performance.now() - t) });
    return value;
  } catch (e) {
    log.push({ step: name, ok: false, ms: Math.round(performance.now() - t), error: msg(e) });
    throw e;
  }
}

async function mintPoTokens(env, log, visitorData, videoId) {
  const challenge = await step(log, 'botguard: challenge', () =>
    getChallenge({ requestKey: REQUEST_KEY, fetchFunction: env.fetch }));
  const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js) throw new Error('brak interpretera BotGuard w odpowiedzi');
  await step(log, 'botguard: eval interpretera', () => env.evalScript(js));
  const client = await step(log, 'botguard: VM', () => BotGuardClient.create({
    program: challenge.program, globalName: challenge.globalName, globalObject: env.global,
  }));
  const webPoSignalOutput = [];
  const bgResponse = await step(log, 'botguard: snapshot', () => client.snapshot({ webPoSignalOutput }));
  const it = await step(log, 'botguard: GenerateIT', async () => {
    const r = await env.fetch(buildURL('GenerateIT', true), {
      method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, bgResponse]),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const [integrityToken, estimatedTtlSecs] = await r.json();
    return { integrityToken, estimatedTtlSecs };
  });
  const minter = await step(log, 'botguard: minter', () => WebPoMinter.create(it, webPoSignalOutput));
  const sessionPot = await step(log, 'pot: sesja (visitorData)', () => minter.mintAsWebsafeString(visitorData));
  const contentPot = await step(log, 'pot: film (videoId)', () => minter.mintAsWebsafeString(videoId));
  return { sessionPot, contentPot, ttl: it.estimatedTtlSecs };
}

async function status(env, url, a, b) {
  try {
    const r = await env.fetch(`${url}&range=${a}-${b}`, { credentials: 'omit' });
    await r.arrayBuffer();
    return r.status;
  } catch (e) { return 'ERR:' + msg(e).slice(0, 40); }
}

export async function runExtractionTest(env, videoId, clients) {
  const log = [];
  const result = { label: env.label, videoId, ua: navigator.userAgent, log, clients: {} };
  Platform.shim.eval = (data) => env.evalFunctionBody(data.output);

  try {
    const yt0 = await step(log, 'innertube: sesja', () =>
      Innertube.create({ fetch: env.fetch, retrieve_player: true, cache: new UniversalCache(false) }));
    const visitorData = yt0.session.context.client.visitorData;
    result.player_id = yt0.session.player?.player_id;
    result.visitorData = !!visitorData;

    let pots = null;
    try { pots = await mintPoTokens(env, log, visitorData, videoId); result.potTtl = pots.ttl; }
    catch { /* zapisane w logu */ }

    const variants = [{ name: 'bez pot', yt: yt0, contentPot: undefined }];
    if (pots) {
      const ytPot = await step(log, 'innertube: sesja z pot', () => Innertube.create({
        fetch: env.fetch, retrieve_player: true, cache: new UniversalCache(false),
        visitor_data: visitorData, po_token: pots.sessionPot,
      }));
      variants.push({ name: 'z pot', yt: ytPot, contentPot: pots.contentPot });
    }

    for (const v of variants) {
      for (const client of clients) {
        const key = `${client} ${v.name}`;
        try {
          const info = await v.yt.getBasicInfo(videoId, { client, po_token: v.contentPot });
          const sd = info.streaming_data;
          const r = { playability: info.playability_status?.status, reason: info.playability_status?.reason };
          if (sd) {
            const f = sd.adaptive_formats ?? [];
            r.adaptive = f.length;
            r.withUrl = f.filter(x => x.url || x.signature_cipher || x.cipher).length;
            r.sabr = !!sd.server_abr_streaming_url;
            const vf = f.filter(x => x.has_video && x.mime_type.includes('avc1') && x.height <= 1080).sort((a, b) => b.height - a.height)[0];
            if (vf && r.withUrl) {
              const url = await vf.decipher(v.yt.session.player);
              const n = Number(vf.content_length);
              r.itag = vf.itag; r.height = vf.height; r.size = n;
              r.hasPotInUrl = url.includes('pot=');
              r.ranges = [
                await status(env, url, 0, MB - 1),
                await status(env, url, Math.floor(n / 2), Math.floor(n / 2) + MB - 1),
                await status(env, url, n - MB, n - 1),
              ].join('/');
              r.url = url; // do testu pelnego pobierania w tle
              const af = f.find(x => x.itag === 140);
              if (af) { r.audioUrl = await af.decipher(v.yt.session.player); r.audioSize = Number(af.content_length); }
            }
          }
          result.clients[key] = r;
        } catch (e) {
          result.clients[key] = { error: msg(e) };
        }
      }
    }
  } catch (e) {
    result.fatal = msg(e);
  }
  return result;
}
