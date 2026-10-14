// Bundles the extension into dist/. Usage: node scripts/build.mjs [--watch]
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  target: 'chrome120',
  sourcemap: 'linked',
  minify: !watch,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const configs = [
  // Content scripts must be classic scripts.
  { ...common, entryPoints: { content: path.join(src, 'content/index.ts') }, format: 'iife', outdir: dist },
  {
    ...common,
    entryPoints: {
      background: path.join(src, 'background/index.ts'),
      popup: path.join(src, 'popup/popup.ts'),
      options: path.join(src, 'options/options.ts'),
      reader: path.join(src, 'reader/reader.ts'),
    },
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    outdir: dist,
  },
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const page of ['popup', 'options', 'reader']) {
    await cp(path.join(src, page, `${page}.html`), path.join(dist, `${page}.html`));
    await cp(path.join(src, page, `${page}.css`), path.join(dist, `${page}.css`));
  }
  await cp(path.join(src, 'shared/ui.css'), path.join(dist, 'ui.css'));
  await cp(path.join(src, 'assets/icons'), path.join(dist, 'icons'), { recursive: true });
  await mkdir(path.join(dist, 'fonts'), { recursive: true });
  const font = path.join(root, 'node_modules/@fontsource/comic-neue');
  await cp(path.join(font, 'files/comic-neue-latin-700-normal.woff2'), path.join(dist, 'fonts/comic-neue-700.woff2'));
  await cp(path.join(font, 'LICENSE'), path.join(dist, 'fonts/OFL-LICENSE.txt'));
  const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
  await cp(path.join(pdfjs, 'legacy/build/pdf.worker.min.mjs'), path.join(dist, 'pdf.worker.min.mjs'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    await cp(path.join(pdfjs, dir), path.join(dist, 'pdfjs', dir), { recursive: true });
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();
if (watch) {
  for (const cfg of configs) await (await context(cfg)).watch();
  console.log('Watching for changes… (static files are copied once; re-run for HTML/CSS changes)');
} else {
  await Promise.all(configs.map((cfg) => build(cfg)));
}
