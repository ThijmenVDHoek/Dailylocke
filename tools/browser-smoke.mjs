// ============================================================================
// browser-smoke.mjs — a small real-browser check for the WebGL/DOM boundary.
//
// JSDOM cannot create a WebGL context, cannot move a real canvas between
// screens, and cannot dispatch the browser's context lifecycle faithfully.
// GitHub Actions can run Chromium with SwiftShader, so keep this check small
// and focused on the failures the headless DOM suite cannot see.
// ============================================================================
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let file = decodeURIComponent(url.pathname);
    if (file === '/') file = '/index.html';
    const absolute = resolve(root, '.' + file);
    if (!absolute.startsWith(root + sep) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(absolute)] || 'application/octet-stream' });
    res.end(readFileSync(absolute));
  } catch (_) {
    res.writeHead(400); res.end('Bad request');
  }
});

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/`;
const pageErrors = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => pageErrors.push(err));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.Game && globalThis.RendererReady && globalThis.RendererReady.loaded,
    null, { timeout: 30000 });
  await page.waitForSelector('#screenTitle:not([hidden])', { timeout: 10000 });

  const result = await page.evaluate(() => {
    globalThis.Game.show('Battle');
    const host = globalThis.document.getElementById('battleHost');
    function config() {
      return {
        player: { name: 'Scout', lv: 100, types: ['Fire'], hp: 1, max: 100, h: 1,
          sid: 'charizard', num: 6, u: [] },
        enemy: { name: 'Target', lv: 100, types: ['Water'], hp: 1, max: 100, h: 1,
          sid: 'blastoise', num: 9, u: [] },
        biomeSeed: 'browser-smoke', biomeTypes: ['Fire'],
      };
    }
    const first = new globalThis.BattleUI();
    first.mount(host);
    first.setupBattle(config());
    const shared = first.r;
    first.unmount();

    const second = new globalThis.BattleUI();
    let lost = 0, restored = 0;
    second.onContextLost = () => { lost++; };
    second.onContextRestored = () => { restored++; };
    second.mount(host);
    second.setupBattle(config());
    const reused = shared ? second.r === shared : second.flat === true;
    const canvas = second.r && second.r.domElement;
    const lostEvent = new globalThis.Event('webglcontextlost', { cancelable: true });
    if (canvas) canvas.dispatchEvent(lostEvent);
    const flatAfterLoss = second.flat === true;
    if (canvas) canvas.dispatchEvent(new globalThis.Event('webglcontextrestored'));
    const restoredOnce = canvas ? restored === 1 : true;
    const prevented = canvas ? lostEvent.defaultPrevented : true;
    const hudLoaded = !!host.querySelector('.battle-hud');
    second.unmount();
    return {
      reused, prevented, lostOnce: canvas ? lost === 1 : true,
      flatAfterLoss, restoredOnce, hudLoaded, mountFlagCleared: host._bm == null,
    };
  });

  const checks = [
    ['BattleUI reuses one renderer', result.reused],
    ['context loss is cancelled', result.prevented],
    ['context loss switches to flat mode', result.flatAfterLoss],
    ['context loss is reported once', result.lostOnce],
    ['context restored is reported once', result.restoredOnce],
    ['DOM HUD survives the WebGL lifecycle', result.hudLoaded],
    ['unmount clears the host ownership flag', result.mountFlagCleared],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
  if (pageErrors.length) {
    for (const err of pageErrors) console.error('pageerror:', err.stack || err.message);
  }
  if (pageErrors.length || checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
