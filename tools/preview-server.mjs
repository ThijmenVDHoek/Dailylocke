// ============================================================================
// preview-server.mjs — tiny static server for local play-testing.
//   node tools/preview-server.mjs [port]
// Binds 0.0.0.0 so remote/preview hosts can reach it. Not used by CI.
// ============================================================================
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8000);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let file = decodeURIComponent(url.pathname);
    if (file === '/') file = '/index.html';
    const absolute = resolve(root, '.' + file);
    if (!absolute.startsWith(root + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(absolute)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // The game loads remote Showdown sprites/music; allow those pages' fetches.
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(absolute));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request: ' + (err && err.message));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Dailylocke preview: http://0.0.0.0:${port}/  (root: ${root})`);
});
