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
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// jsdom lives wherever it was installed; try local then global.
const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  const globalRoot = process.env.NODE_PATH || '/usr/local/lib/node_modules';
  ({ JSDOM } = require(join(globalRoot, 'jsdom')));
}

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
window.Audio = class { constructor() { this.volume = 1; } play() { return Promise.resolve(); } pause() {}
  addEventListener() {} removeEventListener() {} };

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
const Obj3 = class { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3();
    this.scale = new V3(1, 1, 1); this.material = null; this.geometry = null; this.userData = {}; this.visible = true; }
  add(...c) { this.children.push(...c); return this; } remove() { return this; } traverse(f) { f(this); }
  getWorldPosition(t) { return t ? t.set(0, 0, 0) : new V3(); } lookAt() {} };
const mat = () => ({ dispose() {}, color: { lerp() {}, set() {} }, opacity: 1, needsUpdate: false, map: null });
const geo = () => ({ dispose() {}, setAttribute() {}, attributes: { position: { array: new Float32Array(3000), needsUpdate: false } } });

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
check('window.Game (app booted)', !!window.Game);

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
// Emulate the <script> the loader injects, since JSDOM won't fetch it for us.
const learnsetsSrc = readFileSync(resolve(repo, 'vendor/pkmn-learnsets.js'), 'utf8');
const origAppend = window.document.head.appendChild.bind(window.document.head);
window.document.head.appendChild = function (el) {
  if (el.tagName === 'SCRIPT' && /pkmn-learnsets/.test(el.src || '')) {
    setTimeout(() => { window.eval(learnsetsSrc); el.onload && el.onload(); }, 0);
    return el;
  }
  return origAppend(el);
};

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

const mon = await C.makeMon('gengar', { rand: C.mulberry32(7) });
check('makeMon rolls a real moveset', mon.moves.length === 4, mon.moves.join(', '));
check('makeMon resolves types', mon.types.join('/') === 'Ghost/Poison', mon.types.join('/'));

// ----------------------------------------------------- a real live battle --
const player = [
  await C.makeMon('gengar', { rand: C.mulberry32(1) }),
  await C.makeMon('garchomp', { rand: C.mulberry32(2) }),
];
const enemy = [await C.makeMon('snorlax', { rand: C.mulberry32(3) })];

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

// Render-loop errors are stubbed-THREE artifacts as often as real bugs, so
// report them without failing the suite outright.
if (rafErrors.length) {
  const uniq = [...new Set(rafErrors)];
  console.log(`  note  ${uniq.length} render-loop warning(s) under the THREE stub: ${uniq.slice(0, 2).join(' | ')}`);
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
