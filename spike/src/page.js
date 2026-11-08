// Wstrzykiwany do swiata strony youtube.com (S2): fetch i eval samej strony.
import { runExtractionTest } from './extract.js';

const CLIENTS = ['WEB', 'MWEB', 'TV_SIMPLY', 'IOS', 'ANDROID_VR'];
const videoId = document.getElementById('ytdl-spike-page')?.dataset.videoId;

// YouTube wymusza Trusted Types; probujemy wlasnej polityki, a jak sie nie da, zwyklego eval.
let policy = null, evalMode = 'plain';
try {
  policy = window.trustedTypes?.createPolicy('ytdl-spike', { createScript: (s) => s });
  if (policy) evalMode = 'trusted-types';
} catch (e) { evalMode = 'plain (createPolicy: ' + e.message + ')'; }

const wrap = (code) => (policy ? policy.createScript(code) : code);
const indirectEval = eval;

const env = {
  label: 'S2 swiat strony (eval: ' + evalMode + ')',
  fetch: window.fetch.bind(window),
  global: window,
  evalScript: (code) => { indirectEval(wrap(code)); },
  evalFunctionBody: (body) => indirectEval(wrap('(function(){' + body + '\n})()')),
};

runExtractionTest(env, videoId, CLIENTS)
  .catch((e) => ({ label: env.label, fatal: String(e?.message ?? e) }))
  .then((r) => window.postMessage({ type: 'ytdl-spike-page-result', json: JSON.stringify(r) }, '*'));
