// Etap 0, test 2: pelne pobranie strumieni kawalkami (wideo H.264 <= 1080p + audio AAC) i zapis na dysk.
import { Innertube, Platform, UniversalCache } from 'youtubei.js';
import { mkdirSync, writeFileSync } from 'node:fs';

Platform.shim.eval = async (data) => new Function(data.output)();

const VIDEOS = (process.argv[2] || 'jNQXAC9IVRw,aqz-KE-bpKQ').split(',');
const CLIENTS = (process.argv[3] || 'ANDROID_VR,IOS,TV_SIMPLY').split(',');
const MAX_H = Number(process.argv[4] || 1080);
const CHUNK = Number(process.env.CHUNK_MB || 10) * 1024 * 1024, PARALLEL = Number(process.env.PAR || 4);
mkdirSync('out', { recursive: true });

const yt = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false) });

async function download(url, size) {
  const chunks = [];
  for (let s = 0; s < size; s += CHUNK) chunks.push([s, Math.min(s + CHUNK, size) - 1]);
  const parts = new Array(chunks.length);
  let next = 0, done = 0;
  const t = performance.now();
  async function worker() {
    while (next < chunks.length) {
      const i = next++;
      const [a, b] = chunks[i];
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(`${url}&range=${a}-${b}`);
        if (r.ok) { parts[i] = new Uint8Array(await r.arrayBuffer()); break; }
        if (attempt >= 3) throw new Error(`HTTP ${r.status} na zakresie ${a}-${b} (kawalek ${i + 1}/${chunks.length})`);
        await new Promise(res => setTimeout(res, 500 * attempt));
      }
      done += parts[i].byteLength;
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const out = new Uint8Array(size);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  if (o !== size) throw new Error(`rozmiar ${o} != ${size}`);
  const sec = (performance.now() - t) / 1000;
  return { data: out, sec, mbps: (size / 1048576 / sec).toFixed(1) };
}

for (const id of VIDEOS) {
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const f = info.streaming_data?.adaptive_formats ?? [];
      const v = f.filter(x => x.has_video && x.mime_type.includes('avc1') && x.height <= MAX_H).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate)[0];
      const a = f.find(x => x.itag === 140);
      if (!v || !a) { console.log(`${id} ${client}: brak formatow (${info.playability_status?.status})`); continue; }
      const [vu, au] = await Promise.all([v.decipher(yt.session.player), a.decipher(yt.session.player)]);
      const vs = Number(v.content_length), as = Number(a.content_length);
      const [rv, ra] = await Promise.all([download(vu, vs), download(au, as)]);
      writeFileSync(`out/${id}.video.mp4`, rv.data);
      writeFileSync(`out/${id}.audio.m4a`, ra.data);
      console.log(`${id} ${client}: OK "${info.basic_info.title}" ${info.basic_info.duration}s | wideo itag ${v.itag} ${v.height}p ${(vs / 1048576).toFixed(1)} MB w ${rv.sec.toFixed(1)} s (${rv.mbps} MB/s) | audio ${(as / 1048576).toFixed(1)} MB (${ra.mbps} MB/s)`);
      break; // pierwszy dzialajacy klient wystarczy
    } catch (e) {
      console.log(`${id} ${client}: BLAD ${e.message?.slice(0, 200)}`);
    }
  }
}
