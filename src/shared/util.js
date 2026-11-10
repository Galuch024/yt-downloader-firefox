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

/**
 * Lista jakosci MP4 dla filmu. Do 1080p H.264 (gra wszedzie), powyzej VP9/AV1 (flaga hiRes).
 * badge: oznaczenie jak w odtwarzaczu YouTube (HD / 4K / 8K).
 */
export function videoQualities(info) {
  const byHeight = new Map();
  for (const v of info.videos) {
    const cur = byHeight.get(v.height);
    if (!cur || v.fps > cur.fps) byHeight.set(v.height, v);
  }
  if (info.muxed?.some((m) => m.height === 360) && !byHeight.has(360)) byHeight.set(360, { height: 360, fps: 30 });
  return [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((v) => ({
      quality: String(v.height),
      label: `${v.height}p${v.fps > 30 ? v.fps : ''}`,
      hd: v.height >= 720,
      badge: v.height >= 4320 ? '8K' : v.height >= 2160 ? '4K' : v.height >= 720 ? 'HD' : null,
      hiRes: v.height > 1080,
      codec: v.codec === 'av1' ? 'AV1' : v.codec === 'vp9' ? 'VP9' : 'H.264',
    }));
}

/**
 * Formaty audio. copy = bez przeliczania (oryginalny strumien YouTube w nowym pojemniku).
 * - MP3: przeliczane, gra wszedzie
 * - M4A: oryginalne AAC (~128 kb/s), gra wszedzie, bez straty jakosci
 * - Opus: oryginalny Opus (~130-160 kb/s), najlepsza jakosc dzwieku na YouTube
 * - WAV: nieskompresowane PCM (do montazu / programow, ktore nie czytaja formatow stratnych)
 */
export const AUDIO_FORMATS = {
  mp3: { label: 'MP3', ext: 'mp3', copy: false, hint: 'Plays everywhere' },
  m4a: { label: 'M4A', ext: 'm4a', copy: true, hint: 'Original AAC audio, no re-encoding, plays everywhere' },
  opus: { label: 'Opus', ext: 'opus', copy: true, hint: 'Original Opus audio, no re-encoding, best quality on YouTube' },
  wav: { label: 'WAV', ext: 'wav', copy: false, hint: 'Uncompressed PCM for audio and video editors (large files)' },
};
export const isAudioMode = (mode) => Object.hasOwn(AUDIO_FORMATS, mode);

/** "mp3" / "opus" / "mp4-1080" -> [mode, quality] */
export const parseChoice = (choice) => (isAudioMode(choice) ? [choice, null] : ['mp4', String(choice).split('-')[1]]);

export const jobLabel = (mode, height) => AUDIO_FORMATS[mode]?.label ?? `MP4 ${height}p`;

/** Strumien audio uzyty dla danego formatu (do wyboru i do szacowania rozmiaru). */
export function audioFor(info, mode) {
  const best = (codec) => info.audios.filter((a) => a.mime.includes(codec)).sort((a, b) => b.bitrate - a.bitrate)[0];
  const aac = best('mp4a');
  const opus = best('opus');
  if (mode === 'm4a') return aac;
  if (mode === 'opus') return opus;
  if (mode === 'wav') return opus || aac; // dekodowanie z lepszego zrodla
  return aac || opus;
}

/** Szacowany rozmiar pliku audio w bajtach. */
export function audioSize(info, mode, mp3Bitrate = 192) {
  const d = info.duration || 0;
  const a = audioFor(info, mode);
  if (mode === 'mp3') return d * mp3Bitrate * 125;
  if (mode === 'wav') return d * (a?.mime.includes('opus') ? 48000 : 44100) * 4;
  return a?.size || 0;
}

/** Wybiera strumienie do pobrania dla trybu i jakosci. */
export function pickFormats(info, mode, quality) {
  const audioAny = audioFor(info, 'mp4');
  if (isAudioMode(mode)) {
    const audio = audioFor(info, mode);
    if (!audio) throw new Error(mode === 'opus' ? 'No Opus audio for this video' : mode === 'm4a' ? 'No AAC audio for this video' : 'No audio track for this video');
    return { audio };
  }
  const want = Number(quality) || 1080;
  const candidates = info.videos.filter((v) => v.height <= want).sort((a, b) => b.height - a.height || b.fps - a.fps || b.bitrate - a.bitrate);
  const video = candidates[0] || [...info.videos].sort((a, b) => a.height - b.height)[0];
  const muxed = info.muxed?.find((m) => m.height <= want);
  if (muxed && (!video || video.height <= muxed.height)) return { muxed };
  if (!video) throw new Error('No video stream for this video');
  if (!audioAny) throw new Error('No audio track for this video');
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
