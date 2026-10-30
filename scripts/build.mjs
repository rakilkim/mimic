import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const OUTPUT = path.join(ROOT, 'dist');

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
await cp(PUBLIC, OUTPUT, { recursive: true });
console.log('Static frontend copied to dist/. Netlify packages Functions from netlify/functions/.');
