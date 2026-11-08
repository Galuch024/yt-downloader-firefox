// Popup wtyczki: pobieranie z aktywnej karty, z wklejonego adresu i lista pobran.
import { videoIdFromUrl, videoQualities, getSettings, formatBytes } from '../shared/util.js';

const $ = (id) => document.getElementById(id);
const jobs = new Map();
const ACTIVE = ['queued', 'downloading', 'processing', 'saving'];

// ---------------------------------------------------------------- lista pobran

function renderJobs() {
  const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('empty').hidden = list.length > 0;
  $('jobs').replaceChildren(...list.map(jobRow));
}

function jobRow(j) {
  const li = document.createElement('li');
  li.className = 'job';
  const top = document.createElement('div');
  top.className = 'job-top';
  const t = Object.assign(document.createElement('div'), { className: 'job-title', textContent: j.title, title: j.title });
  const badge = Object.assign(document.createElement('span'), { className: 'job-badge', textContent: j.label });
  top.append(t, badge);

  const info = document.createElement('div');
  info.className = 'job-info';
  const left = document.createElement('span');
  if (j.state === 'error') { left.className = 'err'; left.textContent = j.error || 'Error'; }
  else if (j.state === 'downloading') left.textContent = `Downloading ${Math.round(j.progress * 100)}% · ${formatBytes(j.bytes || 0)} / ${formatBytes(j.totalBytes || 0)}`;
  else left.textContent = j.stage || j.state;
  const actions = document.createElement('span');
  actions.className = 'job-actions';
  if (ACTIVE.includes(j.state)) actions.append(linkBtn('Cancel', () => browser.runtime.sendMessage({ type: 'cancel', id: j.id })));
  if (j.state === 'done') actions.append(linkBtn('Show in folder', () => browser.runtime.sendMessage({ type: 'show-download', id: j.id })));
  info.append(left, actions);
  li.append(top, info);

  if (ACTIVE.includes(j.state)) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.style.width = `${Math.round((j.progress || 0) * 100)}%`;
    bar.append(fill);
    li.append(bar);
  }
  return li;
}

function linkBtn(text, onClick) {
  const b = Object.assign(document.createElement('button'), { className: 'link-btn', textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

const port = browser.runtime.connect({ name: 'popup' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'state') { jobs.clear(); for (const j of msg.jobs) jobs.set(j.id, j); }
  if (msg.type === 'job') jobs.set(msg.job.id, msg.job);
  renderJobs();
});

$('clear').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'clear-history' });
  for (const [id, j] of jobs) if (!ACTIVE.includes(j.state)) jobs.delete(id);
  renderJobs();
});
$('open-options').addEventListener('click', () => browser.runtime.openOptionsPage());

// ---------------------------------------------------------------- aktywna karta

async function initCurrent() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const videoId = tab && /^https?:\/\/www\.youtube\.com\//.test(tab.url || '') ? videoIdFromUrl(tab.url) : null;
  if (!videoId) return;
  $('url').value = '';
  $('current').hidden = false;
  $('thumb').src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  $('v-title').textContent = tab.title?.replace(/ - YouTube$/, '') || videoId;
  const status = $('current-status');
  status.textContent = 'Checking available formats…';

  let r;
  try { r = await browser.tabs.sendMessage(tab.id, { type: 'extract', videoId }); }
  catch { status.textContent = 'Refresh the YouTube tab so the extension can work.'; status.classList.add('error'); return; }
  if (!r?.ok) { status.textContent = r?.error?.message || 'Could not get video information.'; status.classList.add('error'); return; }

  const info = r.result;
  $('v-title').textContent = info.title;
  $('v-author').textContent = info.author;
  status.textContent = '';
  const settings = await getSettings();
  const sel = $('quality');
  const qualities = videoQualities(info);
  sel.replaceChildren(...qualities.map((q) => new Option(q.label, q.quality)));
  const def = qualities.find((q) => Number(q.quality) <= Number(settings.defaultQuality)) || qualities[0];
  if (def) sel.value = def.quality;
  $('dl-mp4').disabled = !qualities.length;
  $('actions').hidden = false;

  const go = async (mode, quality) => {
    const res = await browser.runtime.sendMessage({ type: 'enqueue', info, mode, quality, tabId: tab.id });
    status.classList.toggle('error', !res?.ok);
    status.textContent = res?.ok ? `Added: ${res.job.label}` : res?.error || 'Error';
  };
  $('dl-mp3').addEventListener('click', () => go('mp3', null));
  $('dl-mp4').addEventListener('click', () => go('mp4', sel.value));
}

// ---------------------------------------------------------------- z adresu

$('dl-url').addEventListener('click', async () => {
  const status = $('url-status');
  const url = $('url').value.trim();
  const [mode, quality] = $('url-format').value === 'mp3' ? ['mp3', null] : ['mp4', $('url-format').value.split('-')[1]];
  status.classList.remove('error');
  status.textContent = 'Preparing…';
  $('dl-url').disabled = true;
  try {
    const res = await browser.runtime.sendMessage({ type: 'enqueue-url', url, mode, quality });
    status.classList.toggle('error', !res?.ok);
    status.textContent = res?.ok ? `Added: ${res.job.title} (${res.job.label})` : res?.error || 'Error';
  } finally {
    $('dl-url').disabled = false;
  }
});

initCurrent();
