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
  // CI runs Playwright's bundled Chromium; a sandbox without browser downloads
  // can point at any Chromium-family binary instead without changing CI.
  const launchOpts = {
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  };
  if (process.env.BROWSER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    launchOpts.args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--single-process', '--no-zygote', '--use-gl=angle', '--use-angle=swiftshader',
      '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
  }
  browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => pageErrors.push(err));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.Game && globalThis.RendererReady && globalThis.RendererReady.loaded,
    null, { timeout: 30000 });
  await page.waitForSelector('#screenTitle:not([hidden])', { timeout: 10000 });
  await page.waitForSelector('#titleStage .bm-sprites img', { timeout: 10000 });
  const titleLightweight = await page.evaluate(() => ({
    canvases: globalThis.document.querySelectorAll('#titleStage canvas').length,
    environments: globalThis.document.querySelectorAll('#titleStage .bm-env[data-biome]').length,
    sprites: globalThis.document.querySelectorAll('#titleStage .bm-sprites img').length,
  }));

  // The title's 3D environment must vanish the moment a game starts and come
  // back when the title returns -- no zombie canvas, no double scene. The
  // round trip also proves the title and a later battle hand the ONE shared
  // renderer back and forth instead of stacking WebGL contexts.
  const titleRoundTrip = await page.evaluate(async () => {
    globalThis.Game.show('Crossroads');
    await new Promise((r) => globalThis.requestAnimationFrame(
      () => globalThis.requestAnimationFrame(r)));
    const afterLeave = {
      canvases: globalThis.document.querySelectorAll('#titleStage canvas').length,
      environments: globalThis.document.querySelectorAll('#titleStage .bm-env').length,
      sprites: globalThis.document.querySelectorAll('#titleStage .bm-sprites img').length,
    };
    globalThis.Game.show('Title');
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 &&
           !globalThis.document.querySelector('#titleStage canvas')) {
      await new Promise((r) => globalThis.requestAnimationFrame(r));
    }
    const afterReturn = {
      canvases: globalThis.document.querySelectorAll('#titleStage canvas').length,
      environments: globalThis.document.querySelectorAll('#titleStage .bm-env[data-biome]').length,
      sprites: globalThis.document.querySelectorAll('#titleStage .bm-sprites img').length,
    };
    return { afterLeave, afterReturn };
  });

  const result = await page.evaluate(async () => {
    globalThis.Game.show('Battle');
    const host = globalThis.document.getElementById('battleHost');
    // A just-unhidden host can be 0x0 for a frame or two, in which case
    // mount() defers via rAF. Drives slowly on software GL, so always wait
    // for the mount to settle before asserting on it.
    function untilMounted(u) {
      return new Promise((res) => {
        const t0 = Date.now();
        (function poll() {
          if (u.s.mounted || u._mountFailed || Date.now() - t0 > 8000) return res(u.s.mounted);
          globalThis.requestAnimationFrame(poll);
        })();
      });
    }
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
    await untilMounted(first);
    first.setupBattle(config());
    const shared = first.r;
    first.unmount();

    const second = new globalThis.BattleUI();
    let lost = 0, restored = 0;
    second.onContextLost = () => { lost++; };
    second.onContextRestored = () => { restored++; };
    second.mount(host);
    await untilMounted(second);
    second.setupBattle(config());
    const reused = shared ? second.r === shared : second.flat === true;
    const environment = host.querySelector('.bm-env[data-biome]');
    const environmentBeforeLoss = !!environment;
    const canvas = second.r && second.r.domElement;
    const lostEvent = new globalThis.Event('webglcontextlost', { cancelable: true });
    if (canvas) canvas.dispatchEvent(lostEvent);
    const flatAfterLoss = second.flat === true;
    const fallbackEnvironmentAfterLoss = !!host.querySelector('.bm-env') &&
      host.classList.contains('battle-flat');
    if (canvas) canvas.dispatchEvent(new globalThis.Event('webglcontextrestored'));
    const restoredOnce = canvas ? restored === 1 : true;
    const environmentAfterRestore = !!environment && environment.isConnected &&
      host.querySelector('.bm-env') === environment;
    const prevented = canvas ? lostEvent.defaultPrevented : true;
    const hudLoaded = !!host.querySelector('.battle-hud');
    second.unmount();
    return {
      reused, prevented, lostOnce: canvas ? lost === 1 : true,
      environmentBeforeLoss, flatAfterLoss, fallbackEnvironmentAfterLoss,
      restoredOnce, environmentAfterRestore, hudLoaded,
      environmentCleaned: !host.querySelector('.bm-env'),
      mountFlagCleared: host._bm == null,
    };
  });

  // Self-healing regression: after a context loss the browser REFUSES to
  // restore (restoreContext sabotaged). The engine must recover by recreating
  // the renderer in place -- waiting on an event that never comes used to
  // park every battle in flat 2D for the rest of the session.
  const recovery = await page.evaluate(async () => {
    const host = globalThis.document.getElementById('battleHost');
    const ui3 = new globalThis.BattleUI();
    ui3.mount(host);
    await new Promise((res) => {
      const t0 = Date.now();
      (function poll() {
        if (ui3.s.mounted || Date.now() - t0 > 5000) return res();
        globalThis.requestAnimationFrame(poll);
      })();
    });
    const startCanvas = ui3.r && ui3.r.domElement;
    const environment = host.querySelector('.bm-env[data-biome]');
    const out = {
      mounted3D: !!startCanvas && !ui3.flat,
      environmentBeforeLoss: !!environment,
      skipped: false, sawFlat: false, environmentDuringLoss: false, healed: false,
      environmentAfterRecovery: false,
    };
    if (startCanvas) {
      const gl = startCanvas.getContext('webgl2') || startCanvas.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) out.skipped = true;
      else {
        ext.restoreContext = function () { /* never fires webglcontextrestored */ };
        ext.loseContext();
        const t0 = Date.now();
        while (Date.now() - t0 < 9000) {
          if (ui3.flat) {
            out.sawFlat = true;
            out.environmentDuringLoss ||= !!environment && environment.isConnected &&
              host.classList.contains('battle-flat');
          }
          if (!ui3.flat && ui3.r && ui3.r.domElement !== startCanvas && host.querySelector('canvas')) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        out.healed = !ui3.flat && !!ui3.r && ui3.r.domElement !== startCanvas && !!host.querySelector('canvas');
        out.environmentAfterRecovery = !!environment && environment.isConnected &&
          host.querySelector('.bm-env') === environment;
        out.oneCanvas = host.querySelectorAll('canvas').length === 1 && !startCanvas.isConnected;
      }
    }
    try { ui3.unmount(); } catch (_) {}
    out.environmentCleaned = !host.querySelector('.bm-env');
    return out;
  });

  const checks = [
    ['title renders its 3D environment over the perspective base',
      titleLightweight.canvases === 1 && titleLightweight.environments === 1 && titleLightweight.sprites === 2],
    ['starting a game removes the title 3D environment entirely',
      titleRoundTrip.afterLeave.canvases === 0 && titleRoundTrip.afterLeave.environments === 0 &&
      titleRoundTrip.afterLeave.sprites === 0],
    ['returning to the title rebuilds its 3D environment',
      titleRoundTrip.afterReturn.canvases === 1 && titleRoundTrip.afterReturn.environments === 1 &&
      titleRoundTrip.afterReturn.sprites === 2],
    ['BattleUI reuses one renderer', result.reused],
    ['the environment exists before context loss', result.environmentBeforeLoss],
    ['context loss is cancelled', result.prevented],
    ['context loss reveals the always-on environment',
      result.flatAfterLoss && result.fallbackEnvironmentAfterLoss],
    ['context loss is reported once', result.lostOnce],
    ['context restored is reported once', result.restoredOnce],
    ['the same environment survives context restoration', result.environmentAfterRestore],
    ['DOM HUD survives the WebGL lifecycle', result.hudLoaded],
    ['unmount removes the environment and ownership flag',
      result.environmentCleaned && result.mountFlagCleared],
    ['a fresh battle mounts in 3D with its environment underneath',
      recovery.mounted3D && recovery.environmentBeforeLoss],
  ];
  if (!recovery.skipped) {
    checks.push(['a lost context degrades to its CSS environment first',
      recovery.sawFlat && recovery.environmentDuringLoss]);
    checks.push(['renderer self-heals WITHOUT webglcontextrestored', recovery.healed]);
    checks.push(['the same environment remains after renderer recovery',
      recovery.environmentAfterRecovery]);
    checks.push(['renderer replacement leaves exactly one canvas', recovery.oneCanvas]);
  }
  checks.push(['self-healing test unmount removes its environment', recovery.environmentCleaned]);
  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
  if (pageErrors.length) {
    for (const err of pageErrors) console.error('pageerror:', err.stack || err.message);
  }
  if (pageErrors.length || checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
