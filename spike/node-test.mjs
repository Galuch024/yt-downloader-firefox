// Etap 0, test 1: czy youtubei.js w Node daje dzialajace URL-e strumieni (bez wtyczki).
import { Innertube, Platform, UniversalCache } from 'youtubei.js';

Platform.shim.eval = async (data, env) => new Function(data.output)();

const VIDEO = process.argv[2] || 'aqz-KE-bpKQ'; // Big Buck Bunny (CC-BY, Blender Foundation)
const CLIENTS = (process.argv[3] || 'WEB,MWEB,TV,TV_SIMPLY,IOS,ANDROID,ANDROID_VR,WEB_EMBEDDED').split(',');

const yt = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false) });
console.log('player_id:', yt.session.player?.player_id, 'sts:', yt.session.player?.signature_timestamp);

async function probe(url, bytes = 1024 * 1024) {
  const t = performance.now();
  const r = await fetch(url + `&range=0-${bytes - 1}`);
  const buf = r.ok ? await r.arrayBuffer() : null;
  const ms = performance.now() - t;
  return { status: r.status, got: buf?.byteLength ?? 0, kbps: buf ? Math.round(buf.byteLength / 1024 / (ms / 1000)) : 0 };
}

for (const client of CLIENTS) {
  try {
    const info = await yt.getBasicInfo(VIDEO, { client });
    const sd = info.streaming_data;
    const ps = info.playability_status?.status;
    if (!sd) { console.log(`${client}: brak streaming_data (${ps}: ${info.playability_status?.reason ?? ''})`); continue; }
    const adaptive = sd.adaptive_formats ?? [];
    const withUrl = adaptive.filter(f => f.url || f.signature_cipher || f.cipher);
    const v = adaptive.filter(f => f.has_video && f.mime_type.includes('avc1')).sort((a, b) => b.height - a.height)[0];
    const a = adaptive.find(f => f.itag === 140) ?? adaptive.find(f => f.has_audio && !f.has_video);
    const heights = [...new Set(adaptive.filter(f => f.has_video).map(f => `${f.height}${f.mime_type.includes('avc1') ? 'h264' : f.mime_type.includes('av01') ? 'av1' : 'vp9'}`))].join(' ');
    let res = `${client}: ${ps}, adaptive=${adaptive.length} (z URL/cipher: ${withUrl.length}), sabr=${!!sd.server_abr_streaming_url}, formaty: ${heights}`;
    if (v && withUrl.length) {
      const vu = await v.decipher(yt.session.player);
      const au = await a.decipher(yt.session.player);
      const pv = await probe(vu, 4 * 1024 * 1024);
      const pa = await probe(au);
      res += `\n    wideo itag ${v.itag} ${v.height}p: HTTP ${pv.status}, ${pv.got} B, ${pv.kbps} KB/s | audio itag ${a.itag}: HTTP ${pa.status}, ${pa.kbps} KB/s`;
    }
    console.log(res);
  } catch (e) {
    console.log(`${client}: BLAD ${e.message?.slice(0, 200)}`);
  }
}
