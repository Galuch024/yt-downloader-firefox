import { build } from 'esbuild';

await build({
  entryPoints: { background: 'src/background.js', content: 'src/content.js', page: 'src/page.js' },
  outdir: 'ext',
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  platform: 'browser',
  conditions: ['browser'],
  loader: { '.wasm': 'binary' },
  logLevel: 'info',
});
