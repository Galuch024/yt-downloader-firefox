// Etap 0, test 4: czy strumienie HLS (m3u8) daja sie pobrac w calosci bez tokenu PO.
import { Innertube, Platform, UniversalCache } from 'youtubei.js';
Platform.shim.eval = async (data) => new Function(data.output)();

const ID = process.argv[2] || 'j6fSJCIoqLo';
const CLIENTS = (process.argv[3] || 'IOS,ANDROID_VR,TV_SIMPLY,MWEB,WEB').split(',');
const yt = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false) });

for (const client of CLIENTS) {
  try {
    const info = await yt.getBasicInfo(ID, { client });
    const hls = info.streaming_data?.hls_manifest_url;
    if (!hls) { console.log(`${client}: brak hls_manifest_url`); continue; }
    const master = await (await fetch(hls)).text();
    const lines = master.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF')) variants.push({ inf: lines[i], url: lines[i + 1] });
    const audio = lines.filter(l => l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')).length;
    const best = variants.filter(v => /avc1/.test(v.inf)).sort((a, b) => (+(b.inf.match(/BANDWIDTH=(\d+)/)?.[1]) || 0) - (+(a.inf.match(/BANDWIDTH=(\d+)/)?.[1]) || 0))[0];
    console.log(`${client}: ${variants.length} wariantow, audio-media=${audio}; najlepszy avc1: ${best?.inf.match(/RESOLUTION=[^,]+/)?.[0]} ${best?.inf.match(/CODECS="[^"]+"/)?.[0]}`);
    if (!best) continue;
    const pl = await (await fetch(best.url)).text();
    const segs = pl.split('\n').filter(l => l && !l.startsWith('#'));
    const pick = [0, Math.floor(segs.length / 2), segs.length - 1];
    const st = [];
    for (const i of pick) { const r = await fetch(new URL(segs[i], best.url)); const b = await r.arrayBuffer(); st.push(`${r.status}(${(b.byteLength / 1024) | 0}KB)`); }
    console.log(`   ${segs.length} segmentow, poczatek/srodek/koniec: ${st.join(' ')}`);
  } catch (e) { console.log(`${client}: ERR ${e.message.slice(0, 120)}`); }
}
