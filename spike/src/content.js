// Content script prototypu. Na stronie z #ytdl-spike uruchamia test ekstrakcji
// w piaskownicy content scriptu (S1) i w swiecie strony (S2, przez wstrzykniety page.js).
import { runExtractionTest } from './extract.js';

const CLIENTS = ['WEB', 'MWEB', 'TV_SIMPLY', 'IOS', 'ANDROID_VR'];

function videoIdFromUrl() {
  const u = new URL(location.href);
  return u.searchParams.get('v') || u.pathname.split('/shorts/')[1]?.split(/[/?#]/)[0];
}

async function contentWorldTest(videoId, fetchKind) {
  // fetchKind: 'ext' = fetch rozszerzenia (uprawnienia hosta, bez CORS), 'page' = content.fetch (jako strona)
  const f = fetchKind === 'page' && typeof content !== 'undefined' && content.fetch
    ? content.fetch.bind(content) : fetch.bind(globalThis);
  const env = {
    label: `S1 content script (${fetchKind === 'page' ? 'content.fetch' : 'fetch rozszerzenia'})`,
    fetch: f,
    global: globalThis,
    evalScript: (code) => { new Function(code)(); },
    evalFunctionBody: (body) => new Function(body)(),
  };
  return runExtractionTest(env, videoId, CLIENTS);
}

function pageWorldTest(videoId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ label: 'S2 swiat strony', fatal: 'timeout 120 s (page.js nie odpowiedzial)' }), 120_000);
    window.addEventListener('message', function onMsg(ev) {
      if (ev.source !== window || ev.data?.type !== 'ytdl-spike-page-result') return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(JSON.parse(ev.data.json));
    });
    const s = document.createElement('script');
    s.src = browser.runtime.getURL('page.js');
    s.dataset.videoId = videoId;
    s.id = 'ytdl-spike-page';
    s.onerror = () => { clearTimeout(timer); resolve({ label: 'S2 swiat strony', fatal: 'nie udalo sie wstrzyknac page.js (CSP?)' }); };
    (document.head || document.documentElement).appendChild(s);
  });
}

async function main() {
  if (!location.hash.includes('ytdl-spike')) return;
  const videoId = videoIdFromUrl();
  const send = (result) => browser.runtime.sendMessage({ type: 'extract-result', result });
  for (const run of [() => contentWorldTest(videoId, 'ext'), () => contentWorldTest(videoId, 'page'), () => pageWorldTest(videoId)]) {
    let r;
    try { r = await run(); } catch (e) { r = { fatal: String(e?.message ?? e) }; }
    await send(r);
  }
  await browser.runtime.sendMessage({ type: 'extract-finished', videoId });
}

main();
