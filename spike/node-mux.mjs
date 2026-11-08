// Etap 0, test 5: scalanie MP4 w Node na pobranych wczesniej plikach.
import { readFileSync, writeFileSync } from 'node:fs';
import { muxMp4 } from './src/media.js';

const id = process.argv[2] || 'dQw4w9WgXcQ';
const t = performance.now();
const v = new Blob([readFileSync(`out/${id}.video.mp4`)]);
const a = new Blob([readFileSync(`out/${id}.audio.m4a`)]);
const r = await muxMp4(v, a, { title: 'test' });
writeFileSync(`out/${id}.muxed.mp4`, Buffer.from(r.buffer));
console.log(`MP4 ${(r.buffer.byteLength / 1048576).toFixed(1)} MB, ${r.videoCodec}+${r.audioCodec}, ${((performance.now() - t) / 1000).toFixed(1)} s`);
