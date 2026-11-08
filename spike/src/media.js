// Wspolny kod mediow dla prototypu: scalanie MP4 (bez rekodowania) i konwersja do MP3.
import {
  Input, Output, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat, Mp3OutputFormat,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, Conversion, canEncodeAudio,
} from 'mediabunny';

async function copyTrack(track, source) {
  const config = await track.getDecoderConfig();
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(packet, first ? { decoderConfig: config } : undefined);
    first = false;
  }
}

/** Laczy strumien wideo (MP4/avc1) i audio (M4A/mp4a) w jeden plik MP4 bez rekodowania. */
export async function muxMp4(videoBlob, audioBlob, tags = {}) {
  const vIn = new Input({ source: new BlobSource(videoBlob), formats: ALL_FORMATS });
  const aIn = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const vt = await vIn.getPrimaryVideoTrack();
  const at = await aIn.getPrimaryAudioTrack();
  if (!vt || !at) throw new Error('Brak sciezki wideo lub audio');

  const target = new BufferTarget();
  const out = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const vs = new EncodedVideoPacketSource(await vt.getCodec());
  const as = new EncodedAudioPacketSource(await at.getCodec());
  out.addVideoTrack(vs);
  out.addAudioTrack(as);
  if (Object.keys(tags).length) out.setMetadataTags(tags);
  await out.start();
  await Promise.all([copyTrack(vt, vs), copyTrack(at, as)]);
  await out.finalize();
  return { buffer: target.buffer, videoCodec: await vt.getCodec(), audioCodec: await at.getCodec() };
}

/** Konwertuje audio (M4A/WebM) do MP3 z tagami i okladka. Wymaga zarejestrowanego kodera MP3. */
export async function toMp3(audioBlob, { bitrate = 192_000, tags = {}, onProgress } = {}) {
  const input = new Input({ source: new BlobSource(audioBlob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const conversion = await Conversion.init({
    input, output,
    audio: { codec: 'mp3', bitrate },
    tags: () => tags,
  });
  if (!conversion.isValid) throw new Error('Konwersja niemozliwa: ' + JSON.stringify(conversion.discardedTracks.map(t => t.reason)));
  if (onProgress) conversion.onProgress = onProgress;
  await conversion.execute();
  return target.buffer;
}

export { canEncodeAudio };
