// Przetwarzanie mediow: scalanie MP4 bez rekodowania i konwersja do MP3 (LAME w WASM).
import {
  Input, Output, ALL_FORMATS, BlobSource, BufferTarget, StreamTarget, Mp4OutputFormat, Mp3OutputFormat,
  OggOutputFormat, WavOutputFormat,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Conversion, canEncodeAudio,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';

let mp3Ready = null;
function ensureMp3Encoder() {
  mp3Ready ??= canEncodeAudio('mp3').then((native) => { if (!native) registerMp3Encoder(); });
  return mp3Ready;
}

async function copyTrack(track, source, signal, onPacket) {
  const config = await track.getDecoderConfig();
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await source.add(packet, first ? { decoderConfig: config } : undefined);
    first = false;
    onPacket?.(packet);
  }
}

/**
 * Laczy wideo (H.264 / VP9 / AV1) i audio (AAC lub Opus) w jeden plik MP4, bez rekodowania.
 * temp: plik tymczasowy - wynik pisany jest na dysk (fastStart 'reserve': indeks na poczatku pliku,
 * bez trzymania calego filmu w RAM). Bez temp: plik budowany w pamieci.
 * estimate: { duration (s), fps } - do zarezerwowania miejsca na indeks.
 */
export async function muxMp4(videoBlob, audioBlob, { tags = {}, signal, onProgress, temp, estimate = {} } = {}) {
  const vIn = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  const aIn = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const vt = await vIn.getPrimaryVideoTrack();
  const at = await aIn.getPrimaryAudioTrack();
  if (!vt || !at) throw new Error('The downloaded data has no video or audio track');
  const duration = (await vt.computeDuration?.()) || estimate.duration || 0;

  const target = temp ? new StreamTarget(temp.writable, { chunked: true, chunkSize: 16 * 1024 * 1024 }) : new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: temp ? 'reserve' : 'in-memory' }), target });
  const vs = new EncodedVideoPacketSource(await vt.getCodec());
  const as = new EncodedAudioPacketSource(await at.getCodec());
  // gorne oszacowanie liczby pakietow (zapas na zmienna liczbe klatek); nadmiar to tylko kilka KB pustego miejsca
  const secs = Math.max(duration, estimate.duration || 0) + 5;
  out.addVideoTrack(vs, temp ? { maximumPacketCount: Math.ceil(secs * Math.max(estimate.fps || 0, 60) * 1.25) + 500 } : undefined);
  out.addAudioTrack(as, temp ? { maximumPacketCount: Math.ceil(secs * (48000 / 1024) * 1.25) + 500 } : undefined);
  if (Object.keys(tags).length) out.setMetadataTags(tags);
  await out.start();
  await Promise.all([
    copyTrack(vt, vs, signal, (p) => { if (duration) onProgress?.(Math.min(1, p.timestamp / duration)); }),
    copyTrack(at, as, signal),
  ]);
  await out.finalize();
  if (temp) {
    temp.markClosed(); // StreamTarget zamyka strumien przy finalize
    return temp.file();
  }
  return new Blob([target.buffer], { type: 'video/mp4' });
}

const AUDIO_OUT = {
  mp3: { format: () => new Mp3OutputFormat(), audio: (o) => ({ codec: 'mp3', bitrate: o.bitrate * 1000 }), mime: 'audio/mpeg' },
  // M4A i Opus: bez opcji audio Conversion kopiuje pakiety (bez przeliczania)
  m4a: { format: () => new Mp4OutputFormat({ fastStart: 'in-memory' }), audio: () => undefined, mime: 'audio/mp4' },
  opus: { format: () => new OggOutputFormat(), audio: () => undefined, mime: 'audio/ogg' },
  wav: { format: () => new WavOutputFormat({ metadataFormat: 'id3' }), audio: () => ({ codec: 'pcm-s16' }), mime: 'audio/wav' },
};

/**
 * Zapisuje audio w wybranym formacie (mp3 / m4a / opus / wav) z tagami i okladka.
 * temp: plik tymczasowy - wynik trafia na dysk (WAV z dlugiego nagrania ma setki MB).
 */
export async function convertAudio(audioBlob, kind, { bitrate = 192, tags = {}, signal, onProgress, temp } = {}) {
  const spec = AUDIO_OUT[kind];
  if (!spec) throw new Error(`Unknown audio format: ${kind}`);
  if (kind === 'mp3') await ensureMp3Encoder();
  const input = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const target = temp ? new StreamTarget(temp.writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: spec.format(), target });
  const audio = spec.audio({ bitrate });
  const conversion = await Conversion.init({
    input, output,
    ...(audio ? { audio } : {}),
    tags: () => tags,
  });
  if (!conversion.isValid) throw new Error(`Could not convert the audio to ${kind.toUpperCase()}`);
  if (onProgress) conversion.onProgress = onProgress;
  const onAbort = () => conversion.cancel?.();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (temp) { temp.markClosed(); return temp.file(); }
  return new Blob([target.buffer], { type: spec.mime });
}

/** Okladka: kwadratowy kadr ze srodka miniatury (bez czarnych pasow). */
export async function fetchCover(videoId) {
  for (const name of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`);
      if (!r.ok) continue;
      const bmp = await createImageBitmap(await r.blob());
      const contentH = Math.min(bmp.height, Math.round((bmp.width * 9) / 16));
      const side = Math.min(contentH, bmp.width);
      const sx = Math.round((bmp.width - side) / 2);
      const sy = Math.round((bmp.height - side) / 2);
      const size = Math.min(side, 800);
      const canvas = new OffscreenCanvas(size, size);
      canvas.getContext('2d').drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      return new Uint8Array(await blob.arrayBuffer());
    } catch { /* nastepny rozmiar */ }
  }
  return null;
}
