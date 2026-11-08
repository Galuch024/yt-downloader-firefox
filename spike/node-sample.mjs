// Etap 0, test 3: proba roznych filmow; sprawdza zakres na poczatku, w srodku i na koncu strumienia.
import { Innertube, Platform, UniversalCache } from 'youtubei.js';
Platform.shim.eval = async (data) => new Function(data.output)();

const CLIENTS = (process.argv[2] || 'IOS,ANDROID_VR,TV_SIMPLY').split(',');
const QUERIES = ['lofi hip hop 1 hour', 'minecraft shorts', 'podcast full episode', 'music video 2026', 'documentary', 'cooking recipe'];
const yt = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false) });

const ids = new Set();
for (const q of QUERIES) {
  const s = await yt.search(q);
  for (const v of (s.videos ?? []).slice(0, 2)) if (v.video_id || v.id) ids.add(v.video_id || v.id);
}
console.log('filmy:', [...ids].join(','));

async function rangeOk(url, a, b) { const r = await fetch(`${url}&range=${a}-${b}`); await r.arrayBuffer(); return r.status; }

for (const id of ids) {
  const row = [];
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(id, { client });
      const f = info.streaming_data?.adaptive_formats ?? [];
      const v = f.filter(x => x.has_video && x.mime_type.includes('avc1') && x.height <= 1080).sort((a, b) => b.height - a.height)[0];
      if (!v) { row.push(`${client}=${info.playability_status?.status ?? '?'}`); continue; }
      const u = await v.decipher(yt.session.player);
      const n = Number(v.content_length), M = 1048576;
      const st = [await rangeOk(u, 0, M - 1), await rangeOk(u, Math.floor(n / 2), Math.floor(n / 2) + M - 1), await rangeOk(u, Math.max(0, n - M), n - 1)];
      row.push(`${client}=${st.join('/')}`);
    } catch (e) { row.push(`${client}=ERR(${e.message.slice(0, 40)})`); }
  }
  const info = await yt.getBasicInfo(id, { client: 'IOS' }).catch(() => null);
  console.log(`${id} ${String(info?.basic_info.duration ?? '?').padStart(6)}s  ${row.join('  ')}  ${info?.basic_info.title?.slice(0, 50) ?? ''}`);
}
