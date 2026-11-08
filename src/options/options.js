import { getSettings, DEFAULT_SETTINGS, sanitizeFilename } from '../shared/util.js';

const fields = Object.keys(DEFAULT_SETTINGS);
const $ = (id) => document.getElementById(id);
let timer;

async function load() {
  const s = await getSettings();
  for (const k of fields) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = String(s[k]);
  }
  preview();
}

function preview() {
  const f = sanitizeFilename($('subfolder').value || '', 60);
  $('folder-preview').textContent = $('subfolder').value.trim() ? f : '';
}

async function save() {
  const settings = {
    subfolder: $('subfolder').value.trim(),
    saveAs: $('saveAs').checked,
    mp3Bitrate: Number($('mp3Bitrate').value),
    defaultQuality: $('defaultQuality').value,
    concurrency: Number($('concurrency').value),
  };
  await browser.storage.local.set({ settings });
  $('saved').textContent = 'Zapisano';
  clearTimeout(timer);
  timer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

$('form').addEventListener('input', () => { preview(); save(); });
$('form').addEventListener('submit', (e) => e.preventDefault());
load();
