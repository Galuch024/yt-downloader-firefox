// Funkcje wspolne dla tla, content scriptu i popupu.

/** Wyciaga ID filmu z adresu YouTube (watch, shorts, youtu.be, embed, live). */
export function videoIdFromUrl(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return valid(u.pathname.slice(1));
    if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
    if (u.pathname === '/watch') return valid(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch { return null; }
}
const valid = (id) => (id && /^[\w-]{11}$/.test(id) ? id : null);

/** Nazwa pliku bezpieczna dla Windows/Linux/macOS. */
export function sanitizeFilename(name, maxLen = 150) {
  let s = String(name || 'film')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || 'film';
}

/** Lista jakosci MP4 dostepnych dla danego filmu (wysokosci <= 1080, H.264). */
export function videoQualities(info) {
  const byHeight = new Map();
  for (const v of info.videos) {
    const cur = byHeight.get(v.height);
    if (!cur || v.fps > cur.fps) byHeight.set(v.height, v);
  }
  if (info.muxed?.some((m) => m.height === 360) && !byHeight.has(360)) byHeight.set(360, { height: 360, fps: 30 });
  return [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((v) => ({ quality: String(v.height), label: `${v.height}p${v.fps > 30 ? v.fps : ''}`, hd: v.height >= 720 }));
}

/** Wybiera strumienie do pobrania dla trybu i jakosci. */
export function pickFormats(info, mode, quality) {
  const audioMp4 = info.audios.filter((a) => a.mime.includes('mp4a')).sort((a, b) => b.bitrate - a.bitrate)[0];
  const audioAny = audioMp4 || [...info.audios].sort((a, b) => b.bitrate - a.bitrate)[0];
  if (mode === 'mp3') {
    if (!audioAny) throw new Error('Brak sciezki audio dla tego filmu');
    return { audio: audioAny };
  }
  const want = Number(quality) || 1080;
  const candidates = info.videos.filter((v) => v.height <= want).sort((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate);
  const video = candidates[0] || [...info.videos].sort((a, b) => a.height - b.height)[0];
  const muxed = info.muxed?.find((m) => m.height <= want);
  if (muxed && (!video || video.height <= muxed.height)) return { muxed };
  if (!video) throw new Error('Brak strumienia wideo H.264 dla tego filmu');
  if (!audioAny) throw new Error('Brak sciezki audio dla tego filmu');
  return { video, audio: audioAny };
}

export const formatBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export const DEFAULT_SETTINGS = {
  subfolder: 'YouTube',
  saveAs: false,
  mp3Bitrate: 192,
  defaultQuality: '1080',
  concurrency: 2,
};

export async function getSettings() {
  try {
    const s = await browser.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
