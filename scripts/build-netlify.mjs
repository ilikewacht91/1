import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of ['index.html', 'app.js']) {
  await cp(path.join(root, file), path.join(out, file));
}

try {
  await cp(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('assets/ not found. The wall will still work, but background music will be unavailable.');
}

console.log('Netlify publish directory ready: public/');
