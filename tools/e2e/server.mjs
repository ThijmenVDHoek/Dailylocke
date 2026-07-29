// ============================================================================
// server.mjs — a tiny static file server for the E2E suite.
//
// The game must be served over HTTP, not file://, because a service worker
// cannot register on a file: origin -- and "does the app still work offline
// after the worker installs?" is one of the things this suite exists to prove.
//
// Deliberately dependency-free and deliberately dumb: no directory listing,
// no range requests, no caching headers beyond what the test needs.
// ============================================================================
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export async function startServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      // Never serve outside the repo, whatever the client asks for.
      const target = resolve(join(base, normalize(rel)));
      if (target !== base && !target.startsWith(base + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
        'Content-Length': body.length,
        // The worker must be allowed to control the whole subpath.
        'Service-Worker-Allowed': '/',
        // No HTTP caching: the test is about the Cache API, and a 304 from the
        // dev server would muddy exactly what it is measuring.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err && err.message));
    }
  });

  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const { port: actual } = server.address();
  return {
    origin: `http://127.0.0.1:${actual}`,
    async close() { await new Promise((ok) => server.close(ok)); },
  };
}
