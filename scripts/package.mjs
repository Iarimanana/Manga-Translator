// Zips dist/ into release/manga-translator-<version>.zip for the Chrome Web Store or sideloading.
import { zipSync } from 'fflate';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const files = {};
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith('.map')) continue;
  const full = path.join(entry.parentPath, entry.name);
  files[path.relative(dist, full).split(path.sep).join('/')] = new Uint8Array(await readFile(full));
}
await mkdir(path.join(root, 'release'), { recursive: true });
const out = path.join(root, 'release', `manga-translator-${version}.zip`);
await writeFile(out, zipSync(files, { level: 9 }));
console.log(`Wrote ${path.relative(root, out)} (${Object.keys(files).length} files)`);
