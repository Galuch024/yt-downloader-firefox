// Przetwarzanie mediow: scalanie MP4 bez rekodowania i konwersja do MP3 (LAME w WASM).
import {
  Input, Output, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat, Mp3OutputFormat,
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

/** Laczy wideo (MP4/H.264) i audio (M4A/AAC lub Opus) w jeden plik MP4. */
export async function muxMp4(videoBlob, audioBlob, { tags = {}, signal, onProgress } = {}) {
  const vIn = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  const aIn = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const vt = await vIn.getPrimaryVideoTrack();
  const at = await aIn.getPrimaryAudioTrack();
  if (!vt || !at) throw new Error('The downloaded data has no video or audio track');
  const duration = (await vt.computeDuration?.()) || 0;

  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const vs = new EncodedVideoPacketSource(await vt.getCodec());
  const as = new EncodedAudioPacketSource(await at.getCodec());
  out.addVideoTrack(vs);
  out.addAudioTrack(as);
  if (Object.keys(tags).length) out.setMetadataTags(tags);
  await out.start();
  await Promise.all([
    copyTrack(vt, vs, signal, (p) => { if (duration) onProgress?.(Math.min(1, p.timestamp / duration)); }),
    copyTrack(at, as, signal),
  ]);
  await out.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/** Konwertuje audio do MP3 z tagami ID3 i okladka. */
export async function toMp3(audioBlob, { bitrate = 192, tags = {}, signal, onProgress } = {}) {
  await ensureMp3Encoder();
  const input = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const conversion = await Conversion.init({
    input, output,
    audio: { codec: 'mp3', bitrate: bitrate * 1000 },
    tags: () => tags,
  });
  if (!conversion.isValid) throw new Error('Could not convert the audio to MP3');
  if (onProgress) conversion.onProgress = onProgress;
  const onAbort = () => conversion.cancel?.();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return new Blob([target.buffer], { type: 'audio/mpeg' });
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
