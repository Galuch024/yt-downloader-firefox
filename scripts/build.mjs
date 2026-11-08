// Budowanie wtyczki do dist/. Uzycie: node scripts/build.mjs [--dev]
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: 'src/background/index.js',
    content: 'src/content/index.js',
    page: 'src/page/extractor.js',
    popup: 'src/popup/popup.js',
    options: 'src/options/options.js',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  platform: 'browser',
  conditions: ['browser'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { __DEV__: String(dev) },
  logLevel: 'info',
});

// Pliki statyczne
for (const f of ['popup/popup.html', 'popup/popup.css', 'options/options.html', 'options/options.css', 'content/content.css']) {
  cpSync(`src/${f}`, `${out}/${f.split('/').pop()}`);
}
cpSync('src/icons', `${out}/icons`, { recursive: true });

const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
manifest.version = pkg.version;
if (dev) manifest.name += ' (dev)';
// --autotest=URL1,URL2: tylko do testow automatycznych (otwiera karty i odrzuca baner zgod YouTube)
const autotest = process.argv.find((a) => a.startsWith('--autotest='))?.slice(11);
if (autotest) {
  if (!dev) throw new Error('--autotest wymaga --dev');
  manifest.permissions.push('cookies', '<all_urls>');
  writeFileSync(`${out}/autotest.json`, JSON.stringify(autotest.split(',')));
}
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Zbudowano ${dev ? 'wersje deweloperska' : 'wersje produkcyjna'} ${pkg.version} w ${out}/`);
