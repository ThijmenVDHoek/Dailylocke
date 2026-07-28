// ============================================================================
// smoke-test.mjs — loads index.html in a JSDOM document, exactly as a browser
// would (same <script defer> order, same relative URLs), then drives the game
// far enough to prove the modular split still boots and still fights.
//
//   node tools/smoke-test.mjs
//
// WebGL isn't available in JSDOM, so THREE's renderer is stubbed; everything
// else (the sim, the module graph, the run/battle glue) is the real code.
// ============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

const html = readFileSync(resolve(repo, 'index.html'), 'utf8');

// ------------------------------------------------------- script discovery --
// Read the real tag order out of the document rather than hardcoding it, so
// the test breaks if index.html and the module graph ever drift apart.
const scriptSrcs = [...html.matchAll(/<script\s+defer\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
check('index.html lists deferred scripts', scriptSrcs.length > 0, `${scriptSrcs.length} modules`);

const missing = scriptSrcs.filter((s) => !existsSync(resolve(repo, s)));
check('every referenced script exists', missing.length === 0, missing.join(', '));

const cssRefs = [...html.matchAll(/<link[^>]+href="((?!https?:)[^"]+\.css)"/g)].map((m) => m[1]);
const missingCss = cssRefs.filter((c) => !existsSync(resolve(repo, c)));
check('every referenced stylesheet exists', missingCss.length === 0, missingCss.join(', '));

check('index.html no longer inlines the engine', html.length < 200 * 1024,
  `${(html.length / 1024).toFixed(1)} KB`);

// -------------------------------------------------------------- the dom ----
const dom = new JSDOM(html, {
  url: pathToFileURL(resolve(repo, 'index.html')).href,
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

// JSDOM has no layout: give the battle host a real box so BattleUI mounts
// instead of parking itself in the retry queue.
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { get() { return 800; }, configurable: true },
  clientHeight: { get() { return 600; }, configurable: true },
  offsetParent: { get() { return this.parentNode; }, configurable: true },
});
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
};
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 800, height: 600 }]; };

// Minimal WebGL + media stubs.
window.HTMLCanvasElement.prototype.getContext = function () { return null; };
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
window.HTMLMediaElement.prototype.pause = function () {};
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
const rafErrors = [];
window.requestAnimationFrame = (cb) => setTimeout(() => {
  // A throw inside the render loop would otherwise kill the whole process;
  // collect it so it shows up as a failed check instead.
  try { cb(Date.now()); } catch (e) { rafErrors.push(e.message); }
}, 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
// Sprites/cries are network fetches we neither have nor need here.
window.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
  set src(_v) {} get src() { return ''; } addEventListener() {} removeEventListener() {} };
// Records what the audio layer asked for so the music checks can assert on
// track choice and volume without a real media element.
const audioLog = [];
window.Audio = class {
  constructor(src) { this.volume = 1; this.loop = false; this.preload = ''; this.paused = true;
    this.currentTime = 0; this._src = ''; if (src) this.src = src; }
  set src(v) { this._src = v; audioLog.push(v); } get src() { return this._src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {} addEventListener() {} removeEventListener() {}
};

const consoleErrors = [];
window.console = { ...console, error: (...a) => { consoleErrors.push(a.join(' ')); }, warn: () => {} };

// ------------------------------------------------------------ evaluation ---
function evalIn(code, label) {
  try { window.eval(code); return true; }
  catch (e) { check(`${label} evaluates`, false, e.message); return false; }
}

// THREE is a 600 KB UMD bundle that needs a canvas; stub the surface BattleUI
// touches so we can still exercise the real battle-ui.js code paths.
const V3 = class { constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; } copy(v) { return this.set(v.x, v.y, v.z); }
  clone() { return new V3(this.x, this.y, this.z); } lerp() { return this; } project() { return this; }
  setScalar(s) { return this.set(s, s, s); } multiplyScalar() { return this; } add() { return this; }
  normalize() { return this; } length() { return 1; }
  getWorldPosition(t) { return t ? t.set(this.x, this.y, this.z) : this; } };
const mat = () => ({ dispose() {}, color: { lerp() {}, set() {} }, opacity: 1, needsUpdate: false, map: null });
const geo = () => ({ dispose() {}, setAttribute() {}, attributes: { position: { array: new Float32Array(3000), needsUpdate: false } } });
const Obj3 = class { constructor(g, m) { this.children = []; this.position = new V3(); this.rotation = new V3();
    this.scale = new V3(1, 1, 1); this.color = { lerp() { return this; } };
    this.material = m || mat(); this.geometry = g || geo(); this.userData = {}; this.visible = true; }
  add(...c) { this.children.push(...c); return this; } remove() { return this; } traverse(f) { f(this); }
  getWorldPosition(t) { return t ? t.set(0, 0, 0) : new V3(); } lookAt() {} };

window.THREE = new Proxy({
  Vector3: V3, Group: Obj3, Scene: class extends Obj3 { constructor() { super(); this.background = null; this.fog = null; } },
  Color: class { constructor(c) { this.c = c; } lerp() { return this; } set() { return this; } },
  Fog: class { constructor(c, n, f) { Object.assign(this, { color: new window.THREE.Color(c), near: n, far: f }); } },
  Clock: class { getDelta() { return 0.016; } get elapsedTime() { return 1; } },
  PerspectiveCamera: class extends Obj3 { constructor() { super(); this.aspect = 1; } updateProjectionMatrix() {} },
  WebGLRenderer: class { constructor() { this.domElement = window.document.createElement('canvas'); this.shadowMap = {}; }
    setPixelRatio() {} setSize() {} render() {} dispose() {} },
  Mesh: class extends Obj3 { constructor(g, m) { super(); this.geometry = g || geo(); this.material = m || mat(); } },
  Points: class extends Obj3 { constructor(g, m) { super(); this.geometry = g || geo(); this.material = m || mat(); } },
  BufferGeometry: class { constructor() { Object.assign(this, geo()); } },
  BufferAttribute: class { constructor(a) { this.array = a; } },
  Texture: class { constructor() { this.needsUpdate = false; } dispose() {} },
  CanvasTexture: class { constructor() { this.needsUpdate = false; } dispose() {} },
  AmbientLight: Obj3, DirectionalLight: class extends Obj3 { constructor() { super();
    this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0 }; this.castShadow = false; } },
  SRGBColorSpace: 'srgb', ACESFilmicToneMapping: 1, PCFSoftShadowMap: 1, DoubleSide: 2, AdditiveBlending: 2,
}, {
  get(t, k) {
    if (k in t) return t[k];
    const s = String(k);
    if (s.endsWith('Geometry')) return class { constructor() { Object.assign(this, geo()); } };
    if (s.endsWith('Material')) return class { constructor(o) { Object.assign(this, mat(), o); } };
    return class extends Obj3 {};
  },
});

// -------------------------------------------- lazy learnsets interception --
// Emulate the <script> the loader injects, since JSDOM won't fetch it for us.
// This has to be installed BEFORE the modules run: app.js prefetches the
// learnsets chunk from boot(), and PS.learnsetsReady() caches the very first
// promise it creates -- if that one is left dangling, every later await of it
// hangs forever.
const learnsetsSrc = readFileSync(resolve(repo, 'vendor/pkmn-learnsets.js'), 'utf8');
const origAppend = window.document.head.appendChild.bind(window.document.head);
window.document.head.appendChild = function (el) {
  if (el.tagName === 'SCRIPT' && /pkmn-learnsets/.test(el.src || '')) {
    setTimeout(() => { window.eval(learnsetsSrc); el.onload && el.onload(); }, 0);
    return el;
  }
  return origAppend(el);
};

for (const src of scriptSrcs) {
  if (src.includes('three.min.js')) continue;    // stubbed above
  const code = readFileSync(resolve(repo, src), 'utf8');
  if (!evalIn(code, src)) break;
}

// --------------------------------------------------------------- globals ---
check('window.PS (battle engine)', !!window.PS);
check('window.PokeData', !!window.PokeData);
check('window.BattleUI', typeof window.BattleUI === 'function');
check('window.Core', !!window.Core);
check('window.Nuz', !!window.Nuz);
check('window.RogueBattle', !!window.RogueBattle);
check('window.GameAudio', !!window.GameAudio);
check('window.SaveCode', !!window.SaveCode);
check('window.Game (app booted)', !!window.Game);
check('window.PWA (install button)', !!window.PWA);

// --------------------------------------------------- installability / PWA --
// The floating install button on the title screen, plus the path rules that
// decide whether the browser ever considers the app installable at all.
{
  // pwa.js defers its wiring to DOMContentLoaded, exactly like app.js.
  if (window.document.readyState === 'loading') {
    await new Promise((res) => window.document.addEventListener('DOMContentLoaded', res, { once: true }));
  }

  const dock = window.document.getElementById('installDock');
  const btn = window.document.getElementById('btnInstall');
  const hideBtn = window.document.getElementById('btnInstallHide');

  check('install dock exists', !!dock && !!btn && !!hideBtn);
  check('install dock lives on the title screen',
    !!dock && dock.closest('section#screenTitle') !== null,
    'so it hides with the title once a run starts');
  check('install dock is hidden until the browser offers an install',
    dock.hidden === true && window.PWA.mode === '');

  // ---- Chrome/Android path: capture the event, show our own button.
  let promptCalls = 0;
  const bip = new window.Event('beforeinstallprompt', { cancelable: true });
  bip.prompt = () => { promptCalls++; };
  bip.userChoice = Promise.resolve({ outcome: 'dismissed' });
  window.dispatchEvent(bip);

  check('beforeinstallprompt is suppressed in favour of our button',
    bip.defaultPrevented === true);
  check('install dock appears once installable',
    dock.hidden === false && window.PWA.mode === 'prompt');

  btn.click();
  check('tapping Install fires the captured browser prompt', promptCalls === 1);
  check('the pill hides after prompting (the event is single-use)',
    dock.hidden === true && window.PWA.mode === '');

  // ---- the dismiss "x" snoozes rather than nagging every visit.
  const bip2 = new window.Event('beforeinstallprompt', { cancelable: true });
  bip2.prompt = () => { promptCalls++; };
  window.dispatchEvent(bip2);
  check('a fresh prompt event re-offers the pill', dock.hidden === false);
  hideBtn.click();
  check('dismissing snoozes the pill', dock.hidden === true && window.PWA.snoozed === true);

  // ---- installed for real: gone for good, snooze cleared.
  window.dispatchEvent(new window.Event('appinstalled'));
  check('appinstalled retires the pill permanently',
    dock.hidden === true && window.PWA.installed === true && window.PWA.snoozed === false);

  // ---- iOS/Safari have no install API; the pill opens a how-to sheet.
  const sheet = window.document.getElementById('screenInstall');
  const steps = window.document.getElementById('installSteps');
  check('install how-to sheet exists and starts hidden', !!sheet && sheet.hidden === true);
  window.PWA.openSheet();
  check('how-to sheet lists concrete steps',
    sheet.hidden === false && steps.children.length >= 2, `${steps.children.length} steps`);
  window.PWA.closeSheet();
  check('how-to sheet closes', sheet.hidden === true);
}

// --------------------------------------------------------- install paths ---
// This deploys to a GitHub Pages PROJECT site (/Dailylocke/). Root-absolute
// URLs 404 there, which silently makes the app un-installable: no manifest,
// no service worker, so `beforeinstallprompt` never fires and the button above
// can never appear. Guard every path that feeds installability.
{
  const manifest = JSON.parse(readFileSync(resolve(repo, 'manifest.json'), 'utf8'));
  const swSrc = readFileSync(resolve(repo, 'sw.js'), 'utf8');

  const manifestHref = (html.match(/<link rel="manifest" href="([^"]+)"/) || [])[1];
  check('index.html links the manifest relatively',
    !!manifestHref && !manifestHref.startsWith('/'), manifestHref);
  check('manifest start_url + scope are relative',
    !manifest.start_url.startsWith('/') && !String(manifest.scope || '').startsWith('/'),
    `${manifest.start_url} / ${manifest.scope}`);

  const iconPaths = manifest.icons.map((i) => i.src);
  check('manifest icons are relative and present',
    iconPaths.every((p) => !p.startsWith('/') && existsSync(resolve(repo, p))), iconPaths.join(', '));
  // Chrome needs a >=192px "any" icon to install, and a maskable one to avoid
  // a letterboxed launcher badge. One entry marked "any maskable" satisfies
  // neither cleanly, so the two purposes are listed separately.
  check('manifest declares a purpose:any icon >= 192px',
    manifest.icons.some((i) => /(^|\s)any(\s|$)/.test(i.purpose || 'any') && parseInt(i.sizes, 10) >= 192));
  check('manifest declares a maskable icon',
    manifest.icons.some((i) => /(^|\s)maskable(\s|$)/.test(i.purpose || '')));

  check('service worker registers with a relative URL',
    /register\((['"])sw\.js\1/.test(readFileSync(resolve(repo, 'src/pwa.js'), 'utf8')),
    "'/sw.js' would be out of scope on a project page");
  check('service worker precaches relative paths only',
    !/^\s*'\//m.test(swSrc), 'root-absolute shell entries 404 under /Dailylocke/');
  const shellPaths = [...swSrc.matchAll(/^\s*'([^']+)',?$/gm)]
    .map((m) => m[1]).filter((p) => p !== './');
  const missingShell = shellPaths.filter((p) => !existsSync(resolve(repo, p)));
  check('every service-worker app-shell entry exists',
    missingShell.length === 0, missingShell.join(', '));
  check('service worker precaches the new pwa module', swSrc.includes('src/pwa.js'));
  check('licenses and asset credits are linked and precached',
    html.includes('href="THIRD_PARTY_NOTICES.md"') && swSrc.includes("'THIRD_PARTY_NOTICES.md'"));
  check('service worker precache tolerates a missing file',
    /cache\.add\(url\)\.catch/.test(swSrc), 'addAll() would fail install() wholesale');
  check('service worker only deletes Dailylocke caches',
    swSrc.includes('key.startsWith(CACHE_PREFIX)'), 'other apps may share this origin');
  check('app.js no longer registers the worker itself',
    !readFileSync(resolve(repo, 'src/app.js'), 'utf8').includes('serviceWorker.register'),
    'that moved to src/pwa.js');
}

// ------------------------------------------------------ save code transfer --
// Cross-device saves: compress -> share -> decompress -> validate. The codec
// must round-trip perfectly and must never throw on garbage input.
{
  const SC = window.SaveCode;
  check('lz-string loaded', typeof window.LZString !== 'undefined');
  check('qrcode.js loaded', typeof window.QRCode !== 'undefined');
  check('SaveCode.enabled with lz-string present', SC.enabled() === true);

  const state = {
    __v: 2, seed: 42, section: 3, battleInSection: 1,
    party: [{ id: 'gengar', species: 'Gengar', name: 'Casper', hpPct: 0.618,
              moves: ['shadowball', 'sludgebomb', 'focusblast', 'nastyplot'],
              pp: { shadowball: 12 }, sp: { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 } }],
    bag: { pokeball: 5, potion: 3 }, money: 4000, battlesWon: 9, trainersBeaten: 2,
    damageDealt: { 1: 8123 }, sectionStats: { money: 2400, won: 3, caught: null, lost: [], damage: 8123, kos: 2, startedAt: 1 },
  };
  const code = SC.encode(state);
  check('save state compresses to a URL-safe code', /^[A-Za-z0-9+\-$]{40,}$/.test(code),
    `${code.length} chars from ${JSON.stringify(state).length} JSON bytes`);
  check('code round-trips to identical state',
    JSON.stringify(SC.decode(code)) === JSON.stringify(state));
  check('corrupted codes decode to null, never throw',
    SC.decode('not-a-real-code') === null && SC.decode('') === null
    && SC.decode('$$$') === null && SC.decode(null) === null);

  const url = SC.buildShareUrl(code);
  check('share url carries ?save=', url.includes('?save=' + code), url.slice(0, 80));
  check('extractCode parses a full share link', SC.extractCode(url) === code);
  check('extractCode unwraps messy pastes',
    SC.extractCode('  ' + code.slice(0, 40) + '\n' + code.slice(40) + ' ') === code);
  check('extractCode rejects plain junk',
    SC.extractCode('hello world!') === '' && SC.extractCode('') === '');
}

// ----------------------------------------------------------------- audio ---
// Music must be quiet by default, must only play during a battle, and must
// draw from the right pool for the kind of battle.
{
  const GA = window.GameAudio;
  check('music defaults to a quiet level', GA.getMusic() <= 0.4 && GA.getMusic() > 0,
    `slider ${GA.getMusic()}, gain ${GA.musicVolume().toFixed(3)}`);
  check('music gain is well below the old 1.0', GA.musicVolume() < 0.2,
    GA.musicVolume().toFixed(3));
  check('sfx slider exists with a sane default', GA.getSfx() > 0 && GA.getSfx() <= 1, `${GA.getSfx()}`);

  // Every advertised track is a file Showdown actually serves.
  const known = new Set(['bw-rival', 'bw-subway-trainer', 'bw-trainer', 'bw2-homika-dogars',
    'bw2-kanto-gym-leader', 'bw2-rival', 'colosseum-miror-b', 'dpp-rival', 'dpp-trainer',
    'hgss-johto-trainer', 'hgss-kanto-trainer', 'oras-rival', 'oras-trainer', 'sm-rival',
    'sm-trainer', 'spl-elite4', 'xd-miror-b', 'xy-rival', 'xy-trainer']);
  const all = [...GA.TRACKS.wild, ...GA.TRACKS.trainer, ...GA.TRACKS.boss];
  const bogus = all.filter((t) => !known.has(t));
  check('every music track exists on Showdown', bogus.length === 0, bogus.join(', '));
  check('wild and trainer pools are disjoint',
    !GA.TRACKS.wild.some((t) => GA.TRACKS.trainer.includes(t)));

  GA.unlock();
  const before = audioLog.length;
  GA.startBattle('wild');
  const wildSrc = audioLog.slice(before).join('');
  check('wild battle picks from the wild pool',
    GA.TRACKS.wild.some((t) => wildSrc.includes('/' + t + '.mp3')), wildSrc || '(none)');
  check('music volume honours the slider',
    Math.abs(GA.musicVolume() - GA.getMusic() ** 2) < 1e-9);

  const beforeT = audioLog.length;
  GA.startBattle('trainer');
  const trSrc = audioLog.slice(beforeT).join('');
  check('trainer battle picks from the trainer pool',
    GA.TRACKS.trainer.some((t) => trSrc.includes('/' + t + '.mp3')), trSrc || '(none)');

  GA.stop(true);
  check('music stops outside battle', GA.currentTrack === null);

  // Randomised: 30 wild starts should not all land on the same track.
  const seen = new Set();
  for (let i = 0; i < 30; i++) { GA.startBattle('wild'); seen.add(GA.currentTrack); }
  check('battle music is randomised', seen.size > 1, `${seen.size} distinct tracks`);
  GA.stop(true);

  // Muting must be real silence, not a quiet hum.
  const savedMusic = GA.getMusic();
  GA.setMusic(0);
  check('music slider at 0 is silent', GA.musicVolume() === 0);
  GA.setMusic(savedMusic);
  check('music slider round-trips', Math.abs(GA.getMusic() - savedMusic) < 1e-9);
}

const PS = window.PS;
check('gen9 species table loaded', Object.keys(PS.Dex.data.Species).length > 1000,
  `${Object.keys(PS.Dex.data.Species).length} species`);
check('moves table loaded', Object.keys(PS.Dex.data.Moves).length > 900);
check('item descriptions survive the trim',
  /restores/i.test(PS.Dex.items.get('leftovers').desc || ''));
check('learnsets are NOT in the core bundle', Object.keys(PS.Dex.data.Learnsets).length === 0,
  'they load on demand');
check('PS.learnsetsReady exists', typeof PS.learnsetsReady === 'function');

// ------------------------------------------------- lazy learnsets loading --
await PS.learnsetsReady();
check('learnsets chunk loads on demand', Object.keys(PS.Dex.data.Learnsets).length > 1000,
  `${Object.keys(PS.Dex.data.Learnsets).length} entries`);

const gengarLs = await PS.Dex.learnsets.get('gengar');
check('learnset lookup works after injection', Object.keys(gengarLs.learnset || {}).length > 50,
  `${Object.keys(gengarLs.learnset || {}).length} moves`);

// ------------------------------------------------------- game-level logic --
const C = window.Core;
const pool = C.speciesPool();
check('species pool built', pool.length > 800, `${pool.length} entries`);

const mon = await C.makeMon('gengar');
check('makeMon rolls a real moveset', mon.moves.length === 4, mon.moves.join(', '));
check('makeMon resolves types', mon.types.join('/') === 'Ghost/Poison', mon.types.join('/'));

// ----------------------------------------------------- a real live battle --
const player = [
  await C.makeMon('gengar'),
  await C.makeMon('garchomp'),
];
const enemy = [await C.makeMon('snorlax')];

const battleResult = await new Promise((res) => {
  let requests = 0, logLines = 0;
  const timer = setTimeout(() => res({ timeout: true, requests, logLines }), 8000);
  const b = window.RogueBattle.startBattle({
    playerMons: player, enemyMons: enemy, isWild: true, trainerName: 'Wild',
    handlers: {
      onLog(chunk) { logLines += String(chunk).split('\n').length; },
      onRequest(req) {
        requests++;
        if (requests > 40) { clearTimeout(timer); return res({ requests, logLines, capped: true }); }
        // A fainted lead asks for a replacement before it asks for a move.
        if (req && req.forceSwitch) { setTimeout(() => b.chooseSwitch(1), 0); return; }
        if (req && req.active) setTimeout(() => b.chooseMove(0, null), 0);
      },
      onEnd(result) { clearTimeout(timer); res({ ended: true, result, requests, logLines }); },
      onError(e) { clearTimeout(timer); res({ error: e.message, requests, logLines }); },
    },
  });
});

check('battle produced protocol output', (battleResult.logLines || 0) > 20,
  `${battleResult.logLines} lines`);
check('battle asked the player for moves', (battleResult.requests || 0) > 0,
  `${battleResult.requests} requests`);
check('battle ran without engine errors', !battleResult.error, battleResult.error);
check('battle reached a conclusion', !!battleResult.ended || !!battleResult.capped,
  battleResult.timeout ? 'TIMED OUT' : 'ok');

// --------------------------------------------------------- BattleUI mount --
const host = window.document.getElementById('battleHost');
const ui = new window.BattleUI();
ui.mount(host);
check('BattleUI mounts', ui.s.mounted === true);

// The regression this refactor targets: setupBattle() before mount() finishes.
const ui2 = new window.BattleUI();
const host2 = window.document.createElement('div');
window.document.body.appendChild(host2);
let threw = null;
try {
  ui2.setupBattle({
    player: { name: 'A', lv: 100, types: ['Fire'], hp: 1, max: 100, h: 1, sid: 'charizard', num: 6, u: [] },
    enemy: { name: 'B', lv: 100, types: ['Water'], hp: 1, max: 100, h: 1, sid: 'blastoise', num: 9, u: [] },
    biomeSeed: 'x', biomeTypes: ['Fire'],
  });
  ui2.mount(host2);
} catch (e) { threw = e.message; }
check('setupBattle() before mount() does not throw', !threw, threw);
check('deferred setup is replayed on mount', ui2.s.mounted === true && !!ui2.s.biomeKey,
  `biome=${ui2.s.biomeKey}`);

const realErrors = consoleErrors.filter((e) => !/THREE|WebGL|cry|audio|sprite/i.test(e));
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

check('battle render loop stays error-free', rafErrors.length === 0,
  [...new Set(rafErrors)].slice(0, 2).join(' | '));

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
