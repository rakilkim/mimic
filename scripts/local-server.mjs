import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGameRequest } from '../src/game-service.mjs';
import { LocalBlobStore } from '../src/local-blob-store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const blobs = new LocalBlobStore();
const GAME_ROUTE = '/.netlify/functions/game';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

async function readIncomingBody(request, maximumBytes = 16_000) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maximumBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendWebResponse(response, outgoing) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  response.arrayBuffer().then((body) => outgoing.end(Buffer.from(body))).catch(() => outgoing.end());
}

const server = http.createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url || '/', `http://${incoming.headers.host || 'localhost'}`);
  try {
    if (url.pathname === GAME_ROUTE) {
      const body = ['GET', 'HEAD'].includes(incoming.method || 'GET')
        ? undefined
        : await readIncomingBody(incoming);
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body: body?.length ? body : undefined,
      });
      sendWebResponse(await handleGameRequest(request, blobs), outgoing);
      return;
    }

    if (!['GET', 'HEAD'].includes(incoming.method || 'GET')) {
      outgoing.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Method not allowed');
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const absolute = path.resolve(PUBLIC, relative);
    if (!absolute.startsWith(`${PUBLIC}${path.sep}`) && absolute !== path.join(PUBLIC, 'index.html')) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const contents = await readFile(absolute);
    outgoing.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
      'content-length': contents.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    outgoing.end(incoming.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Not found');
      return;
    }
    outgoing.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    outgoing.end(JSON.stringify({ error: error?.message || 'The game ran into a hiccup.' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MIMIC local preview is ready at http://localhost:${PORT}`);
  console.log('This preview uses in-memory room storage; rooms reset when the preview stops.');
});
