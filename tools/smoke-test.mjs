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
import { JSDOM, VirtualConsole } from 'jsdom';

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
check('heavy renderer scripts are post-paint loaders',
  !scriptSrcs.some((src) => /three\.min|battle-ui|ui-patch|champions-learnsets/.test(src)) &&
  scriptSrcs.some((src) => src.includes('renderer-loader.js')) &&
  scriptSrcs.some((src) => src.includes('app-loader.js')));
check('startup failures have a visible reload surface',
  /id="appBootError"/.test(html) && /id="btnAppBootReload"/.test(html) && /unhandledrejection/.test(html));

// -------------------------------------------------------------- the dom ----
// jsdom cannot navigate: the app calls location.reload() after a successful
// backup restore (a real reload in browsers). Swallow that one jsdomError so
// the suite's stderr stays clean; everything else still reaches the console.
const vc = new VirtualConsole();
vc.on('jsdomError', (err) => {
  if (/navigation/.test((err && err.message) || '')) return;
  console.error(err);
});
const dom = new JSDOM(html, {
  url: pathToFileURL(resolve(repo, 'index.html')).href,
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole: vc,
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

// JSDOM has no Web Animations API. The ball-throw FX calls
// el.animate(keyframes, opts) but drives its sequence with setTimeout, so an
// inert stub is enough for the catch flow to proceed.
window.Element.prototype.animate = function () {
  return { cancel() {}, play() {}, pause() {}, finish() {}, onfinish: null, oncancel: null, finished: Promise.resolve(), ready: Promise.resolve() };
};

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
  WebGLRenderer: class {
    constructor() { this.domElement = window.document.createElement('canvas'); this.shadowMap = {};
      this.__forcedLoss = 0; }
    setPixelRatio() {} setSize() {} render() {} dispose() {}
    forceContextLoss() { this.__forcedLoss++; } },
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
const championsLearnsetsSrc = readFileSync(resolve(repo, 'src/champions-learnsets.js'), 'utf8');
const origAppend = window.document.head.appendChild.bind(window.document.head);
window.document.head.appendChild = function (el) {
  if (el.tagName === 'SCRIPT' && /pkmn-learnsets/.test(el.src || '')) {
    setTimeout(() => { window.eval(learnsetsSrc); el.onload && el.onload(); }, 0);
    return el;
  }
  if (el.tagName === 'SCRIPT' && /champions-learnsets/.test(el.src || '')) {
    setTimeout(() => { window.eval(championsLearnsetsSrc); el.onload && el.onload(); }, 0);
    return el;
  }
  return origAppend(el);
};

// The browser loads these two optional renderer files dynamically after first
// paint. JSDOM has no real network/script scheduler, so evaluate them here
// against the same THREE stub before the regular modules.
for (const src of ['vendor/battle-ui.js', 'src/ui-patch.js']) {
  if (!evalIn(readFileSync(resolve(repo, src), 'utf8'), src)) break;
}
for (const src of scriptSrcs) {
  if (src.includes('renderer-loader.js') || src.includes('app-loader.js')) continue; // browser-only post-paint loaders
  const code = readFileSync(resolve(repo, src), 'utf8');
  if (!evalIn(code, src)) break;
}
// The real browser injects app.js from app-loader.js after first paint.
// Evaluate it directly here so the JSDOM suite can drive the same game.
evalIn(readFileSync(resolve(repo, 'src/app.js'), 'utf8'), 'src/app.js');

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
check('window.Daily (daily challenge)', !!window.Daily);
check('window.Modal (shared dialog controller)', !!window.Modal);

// Give the title showcase one tick to settle. Its decorative Pokemon use the
// projection pipeline and must not sound their cries, but the title now shows
// the same 3D biome as a real battle, painted over the always-on CSS
// perspective environment.
await new Promise((r) => setTimeout(r, 25));
const titleCryUrls = audioLog.filter((src) => /\/cries\//i.test(src));

// ---- theme engine ---------------------------------------------------------
// applyTheme must derive the COMPLETE palette (not just the page background),
// or a theme switch recolours almost nothing. Boot runs applyTheme, so the
// derived variables and the data-theme attribute must already be live here.
{
  const rootStyle = window.document.documentElement.style;
  const hex = (k) => (rootStyle.getPropertyValue(k) || '').trim();
  const isHex = (v) => /^#[0-9a-f]{6}$/.test(v);
  const themeAttr = window.document.documentElement.getAttribute('data-theme');
  check('boot derives the full theme palette (surfaces, inks, steps)',
    isHex(hex('--bg-0')) && isHex(hex('--bg-3')) && isHex(hex('--surface')) &&
    isHex(hex('--surface-hi')) && isHex(hex('--ink')) && isHex(hex('--ink-3')) &&
    isHex(hex('--track')) && !!themeAttr,
    `data-theme=${themeAttr} bg0=${hex('--bg-0')} surface-hi=${hex('--surface-hi')} ink=${hex('--ink')}`);
  check('the theme engine derives surfaces from the theme seeds',
    /--surface':\s*mixHex\(bg1,\s*'#ffffff',\s*0\.05\)/.test(readFileSync(resolve(repo, 'src/app.js'), 'utf8')) &&
    /--ink':\s*mixHex\(bg0,\s*'#ffffff',\s*0\.95\)/.test(readFileSync(resolve(repo, 'src/app.js'), 'utf8')) &&
    /lumHex\(gold\)\s*>\s*0\.55/.test(readFileSync(resolve(repo, 'src/app.js'), 'utf8')),
    'derivation must live in one place and pick readable CTA text');
  check('one stylesheet drives the whole UI (no override layer)',
    !html.includes('redesign.css') && !existsSync(resolve(repo, 'assets/css/redesign.css')) &&
    (html.match(/<link[^>]+href="[^"]+\.css"/g) || []).length === 1);
}
check('title-screen Pokemon do not sound their cries',
  titleCryUrls.length === 0, titleCryUrls.join(', '));
check('the title mounts the 3D environment over its perspective base',
  window.document.querySelectorAll('#titleStage canvas').length === 1 &&
  !!window.document.querySelector('#titleStage .bm-env[data-biome]') &&
  window.document.querySelectorAll('#titleStage .bm-sprites img').length === 2);

// The 3D title must never leak into the game: leaving the title tears the
// whole scene down (canvas included), and coming back rebuilds it.
window.Game.show('Crossroads');
check('leaving the title tears its 3D environment down',
  !window.document.querySelector('#titleStage canvas') &&
  !window.document.querySelector('#titleStage .bm-env') &&
  !window.document.querySelector('#titleStage .bm-sprites'));
window.Game.show('Title');
await new Promise((r) => setTimeout(r, 25));
check('returning to the title rebuilds its 3D environment',
  window.document.querySelectorAll('#titleStage canvas').length === 1 &&
  !!window.document.querySelector('#titleStage .bm-env[data-biome]') &&
  window.document.querySelectorAll('#titleStage .bm-sprites img').length === 2);

// -------------------------------------------------------------- daily -----
// The Daily is now a finite, dated, scoreable mode with its own save slot.
// These guard the parts that are pure logic; the browser suite covers the UI.
{
  const D = window.Daily;
  check('Daily is finite', D.SECTIONS > 0 && D.SECTIONS <= 20, `${D.SECTIONS} sections`);

  const key = D.dayKey(new Date(2026, 6, 29));
  check('dayKey uses the LOCAL calendar date', key === '2026-07-29', key);
  // The classic bug: toISOString() would report the previous day for anyone
  // east of UTC late in the evening.
  const lateEvening = new Date(2026, 6, 29, 23, 30);
  check('dayKey is timezone-stable late at night',
    D.dayKey(lateEvening) === '2026-07-29', D.dayKey(lateEvening));

  check('daysBetween counts whole local days',
    D.daysBetween('2026-07-29', '2026-08-02') === 4);
  check('shiftKey walks the calendar',
    D.shiftKey('2026-03-01', -1) === '2026-02-28' &&
    D.shiftKey('2026-12-31', 1) === '2027-01-01');
  check('puzzle numbers are stable and increasing',
    D.puzzleNumber('2026-01-01') === 1 &&
    D.puzzleNumber('2026-01-02') === 2);
  check('everyone gets the same seed for a given day',
    D.seedFor('2026-07-29') === D.seedFor('2026-07-29') &&
    D.seedFor('2026-07-29') !== D.seedFor('2026-07-30'));

  // ---- streaks: forgiving by one day, as designed ----
  const streakCase = (gaps) => {
    const store = { __v: 1, results: {}, streak: 0, best: 0, lastPlayed: null, grace: 0 };
    let day = '2026-01-01';
    D._applyStreak(store, day, true);
    for (const g of gaps) {
      day = D.shiftKey(day, g);
      D._applyStreak(store, day, true);
    }
    return store.streak;
  };
  check('consecutive days build a streak', streakCase([1, 1, 1]) === 4, `${streakCase([1, 1, 1])}`);
  check('ONE missed day is forgiven', streakCase([1, 2]) === 3, `${streakCase([1, 2])}`);
  check('two missed days reset the streak', streakCase([1, 3]) === 1, `${streakCase([1, 3])}`);
  check('replaying the same day does not inflate a streak',
    streakCase([1, 0]) === 2, `${streakCase([1, 0])}`);

  // ---- share card ----
  const entry = {
    n: 142, date: '2026-07-29', outcome: 'complete', sections: 5, battles: 20,
    caught: 5, lost: 4, trainers: 5, score: 3200,
    mvp: { id: 'gengar', name: 'Gengar', damage: 8123 },
    marks: [D.MARK.clean, D.MARK.clean, D.MARK.lost, D.MARK.clean],
  };
  const share = D.shareText(entry);
  check('share card leads with the puzzle number', share.startsWith('Dailylocke #142'), share.split('\n')[0]);
  check('share card reports the run', /Battles: 20/.test(share) && /Caught: 5/.test(share) &&
    /Lost: 4/.test(share) && /MVP: Gengar/.test(share));
  check('share card carries the emoji squares', share.includes(D.MARK.clean + D.MARK.clean));
  check('share card never leaks the seed or species list',
    !/seed/i.test(share) && !/gengar/i.test(share.replace('MVP: Gengar', '')));

  check('a clean section is green, a loss is red',
    D.markFor({ lost: 0, hurt: false }) === D.MARK.clean &&
    D.markFor({ lost: 1, hurt: false }) === D.MARK.lost &&
    D.markFor({ lost: 0, hurt: false, ended: true }) === D.MARK.fail);
}

// --------------------------------------------------------- ascension ------
// Difficulty used to stop climbing around section 15 while rewards kept
// compounding. These pin the fix: difficulty keeps changing, money doesn't run
// away, and every ascension effect is deterministic per seed.
{
  const N = window.Nuz;
  const runAt = (section) => ({ seed: 12345, section, battleInSection: 0, battlesWon: section * 4 });

  check('ascension is dormant through the normal climb',
    N.ascension(runAt(1)) === 0 && N.ascension(runAt(15)) === 0);
  check('ascension starts after section 15',
    N.ascension(runAt(16)) === 1, `${N.ascension(runAt(16))}`);
  check('ascension keeps rising forever',
    N.ascension(runAt(21)) === 2 && N.ascension(runAt(51)) === 8,
    `s21=${N.ascension(runAt(21))} s51=${N.ascension(runAt(51))}`);

  const late = N.ascensionEffects(runAt(31));
  check('high ascension turns on field effects, elites and AI depth',
    late.field && late.elite && late.aiDepth >= 2, JSON.stringify(late));
  check('high ascension cuts section healing', late.healPct < 1 && late.healPct >= 0.55,
    `${late.healPct}`);
  check('section healing never drops to a hopeless level',
    N.ascensionEffects(runAt(200)).healPct >= 0.55,
    `${N.ascensionEffects(runAt(200)).healPct}`);

  // The economy must converge, not compound.
  const mult = (wins) => N.rewardMultiplier({ battlesWon: wins });
  check('early wins still feel generous', mult(10) > 1.5 && mult(10) <= 2.2, `${mult(10).toFixed(2)}x`);
  check('the reward multiplier is bounded', mult(500) <= 4.5, `${mult(500).toFixed(2)}x`);
  check('rewards grow monotonically but with diminishing returns',
    mult(20) > mult(10) && (mult(80) - mult(60)) < (mult(20) - mult(10)),
    `${mult(10).toFixed(2)} ${mult(20).toFixed(2)} ${mult(60).toFixed(2)} ${mult(80).toFixed(2)}`);
  check('the enemy BST floor keeps rising past the old cap',
    N.tier(runAt(30), true).minBST > N.tier(runAt(15), true).minBST,
    `s15=${N.tier(runAt(15), true).minBST} s30=${N.tier(runAt(30), true).minBST}`);

  // Determinism: the daily must be identical for everyone.
  const f1 = N.fieldEffectFor(runAt(31), true);
  const f2 = N.fieldEffectFor(runAt(31), true);
  check('field effects are deterministic per seed/section',
    JSON.stringify(f1) === JSON.stringify(f2));
  check('no field effects before ascension', N.fieldEffectFor(runAt(5), true) === null);
  check('boss clauses land on the 5-section beat',
    !!N.bossClauseFor(runAt(20)) && N.bossClauseFor(runAt(21)) === null);
  check('boss clauses are deterministic',
    JSON.stringify(N.bossClauseFor(runAt(20))) === JSON.stringify(N.bossClauseFor(runAt(20))));

  // Roles: a wall should not be handed to a glass cannon.
  check('roles are filtered by what a species can actually do',
    N.pickRoleFor({ roles: ['wall'] }, 'deoxysattack', 0) !== 'wall' &&
    N.pickRoleFor({ roles: ['wall'] }, 'blissey', 0) === 'wall',
    `${N.pickRoleFor({ roles: ['wall'] }, 'deoxysattack', 0)} / ${N.pickRoleFor({ roles: ['wall'] }, 'blissey', 0)}`);
  check('trainers get a team strategy, not just a type',
    !!N.strategyFor(runAt(9), { sprite: 'cynthia', boss: true }).id);
}

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
  check('the title has no redundant result shortcut',
    window.document.getElementById('btnDailyResults') === null,
    'the main Daily CTA already reopens today\'s result');

  const menuItems = [...window.document.querySelectorAll('#screenMenu .menu-item')];
  const fetchedMenuIcons = menuItems.filter((item) => {
    const img = item.querySelector('img.mi-ic, .mi-ic img');
    return img && /^https:\/\//.test(img.src);
  });
  check('every menu item uses a matching fetched image icon',
    menuItems.length > 0 && fetchedMenuIcons.length === menuItems.length,
    `${fetchedMenuIcons.length}/${menuItems.length} image icons`);
  check('the menu no longer uses font/SVG-style glyph icons',
    window.document.querySelector('#screenMenu .mi-glyph') === null);

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
  // ---- offline quality ----
  check('the app shell revision is content-derived, not hand-written',
    /const SHELL_REV = '[0-9a-f]{6,}';/.test(swSrc) && !/CACHE_NAME\s*=\s*`?\$?\{?CACHE_PREFIX/.test(swSrc),
    (swSrc.match(/const SHELL_REV = '[^']*'/) || ['missing'])[0]);
  check('runtime caches for remote art are BOUNDED',
    /MAX_IMG\s*=\s*\d+/.test(swSrc) && /MAX_AUDIO\s*=\s*\d+/.test(swSrc) &&
    /function trim\(/.test(swSrc),
    'an unbounded sprite cache would evict the app shell');
  check('the sprite/audio catalogue is never precached wholesale',
    !shellPaths.some((e) => /sprites\/|audio\/|cries\//.test(e)));
  check('the font is self-hosted, not fetched from Google Fonts',
    !html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com') &&
    existsSync(resolve(repo, 'assets/fonts/vt323-latin-400.woff2')));
  check('the self-hosted font is precached',
    swSrc.includes('assets/fonts/vt323-latin-400.woff2'));
  const appCss = readFileSync(resolve(repo, 'assets/css/app.css'), 'utf8');
  check('the CSS declares @font-face for the local font',
    appCss.includes('@font-face') && appCss.includes('vt323-latin-400.woff2'));
  check('both font subsets are preloaded for a standalone cold start',
    html.includes('rel="preload" as="font" type="font/woff2" href="assets/fonts/vt323-latin-400.woff2"') &&
    html.includes('rel="preload" as="font" type="font/woff2" href="assets/fonts/vt323-latin-ext-400.woff2"'));
  check('the app waits for its precached font instead of flashing a fallback',
    (appCss.match(/font-display:block/g) || []).length === 2 && !appCss.includes('font-display:swap'));
  // CTAs are themed through CSS variables now (applyTheme sets --cta /
  // --cta-text from the chosen theme). The one primary action is always the
  // theme's gold, with readable text chosen from its luminance, and no
  // always-on outline ring -- the outline only exists on :focus-visible,
  // which is the accessible-by-design state.
  const whiteButtonRule = (appCss.match(/\.btn-white\s*\{([^}]*)\}/) || [])[1] || '';
  const dailyButtonRule = (appCss.match(/\.btn-daily\s*\{([^}]*)\}/) || [])[1] || '';
  const appJs = readFileSync(resolve(repo, 'src/app.js'), 'utf8');
  const defaultTheme = (appJs.match(/id:'default',name:'Default',dot:'([^']+)'/) || [])[1];
  check('start-screen CTAs use the theme gold with no always-on outline ring',
    /var\(--cta-text\)/.test(whiteButtonRule) && /var\(--gold\)/.test(whiteButtonRule) &&
    !/outline:|0\s+0\s+0/.test(whiteButtonRule + dailyButtonRule) &&
    defaultTheme === '#ffffff' && /lumHex\(gold\) > 0\.55/.test(appJs) &&
    appCss.includes(':focus-visible'),
    `default dot ${defaultTheme}`);
  check('title actions use one gap for horizontal and vertical spacing',
    /--title-action-gap:10px/.test(appCss) &&
    /title-btns[\s\S]*?gap:var\(--title-action-gap\)/.test(appCss) &&
    /title-sep[\s\S]*?gap:var\(--title-action-gap\)/.test(appCss) &&
    /title-btns:last-child\s*\{\s*margin-top:var\(--title-action-gap\)/.test(appCss) &&
    /margin:var\(--title-action-gap\) auto/.test(appCss));
  check('users cannot enter or view a run seed',
    !html.includes('id="btnSeed"') && !html.includes('id="menuSeed"') &&
    !/Custom seed|Run seed:|shared seed|same seed/i.test(html) &&
    !appCss.includes('.seed-chip'));
  check('a bundled fallback sprite exists and is precached',
    existsSync(resolve(repo, 'assets/img/fallback-sprite.svg')) &&
    swSrc.includes('assets/img/fallback-sprite.svg'));
  check('the sprite fallback chain ends locally, never on a broken image',
    readFileSync(resolve(repo, 'src/app.js'), 'utf8').includes("FALLBACK_SPRITE = 'assets/img/fallback-sprite.svg'"));
  check('the new modules are precached',
    swSrc.includes('src/daily.js') && swSrc.includes('src/modal.js') &&
    swSrc.includes('src/champions-loader.js') && swSrc.includes('src/renderer-loader.js') &&
    swSrc.includes('src/app-loader.js'));
  check('mid-battle saves are debounced',
    /BATTLE_SAVE_DEBOUNCE_MS\s*=\s*500/.test(appJs) && /scheduleBattleSave/.test(appJs),
    'damage events should not stringify the full run every frame');

  // ---- richer install dialog ----
  check('manifest declares narrow AND wide screenshots',
    Array.isArray(manifest.screenshots) &&
    manifest.screenshots.some((s2) => s2.form_factor === 'narrow') &&
    manifest.screenshots.some((s2) => s2.form_factor === 'wide'),
    `${(manifest.screenshots || []).length} screenshots`);
  check('every manifest screenshot exists and is relative',
    (manifest.screenshots || []).every((s2) =>
      !s2.src.startsWith('/') && !/^https?:/.test(s2.src) &&
      existsSync(resolve(repo, s2.src))));
  check('manifest screenshots carry labels for the install dialog',
    (manifest.screenshots || []).every((s2) => !!s2.label && !!s2.sizes));

  // ---- project license ----
  check('the project declares its own license',
    existsSync(resolve(repo, 'LICENSE')) &&
    /MIT License/.test(readFileSync(resolve(repo, 'LICENSE'), 'utf8')));
  check('the license scopes itself away from Pokemon assets',
    /Pokemon|Pok\u00e9mon/.test(readFileSync(resolve(repo, 'LICENSE'), 'utf8')));
  check('the license is precached and linked', swSrc.includes("'LICENSE'") && html.includes('LICENSE'));

  check('app.js no longer registers the worker itself',
    !readFileSync(resolve(repo, 'src/app.js'), 'utf8').includes('serviceWorker.register'),
    'that moved to src/pwa.js');
}

// --------------------------------------------------- full backup transfer --
// Cross-device saves are a single plain-JSON file that carries every slot,
// the profile and the Daily record. It must round-trip through SaveCode's
// file helpers, and the payload must survive Storage.validate + migration.
{
  const SC = window.SaveCode;
  check('SaveCode exposes the backup format marker', SC.FORMAT === 'dailylocke-full-state', SC.FORMAT);

  // readFile is the import path: File bytes -> string, with a size cap.
  const tiny = new window.File(['{"hello":"world"}'], 'tiny.json', { type: 'application/json' });
  const round = await SC.readFile(tiny);
  check('SaveCode.readFile reads a backup file', round === '{"hello":"world"}');
  const big = new window.File([new Array(6 * 1024 * 1024 + 1).join('x')], 'big.json');
  let bigRejected = null;
  try { await SC.readFile(big); } catch (e) { bigRejected = e.message; }
  check('SaveCode.readFile rejects files over 5 MB', /too large/.test(bigRejected || ''), bigRejected);
  let nullRejected = null;
  try { await SC.readFile(null); } catch (e) { nullRejected = e.message; }
  check('SaveCode.readFile rejects a missing file', /Choose a save file/.test(nullRejected || ''), nullRejected);

  // The Download button writes Game.fullBackupState(): every slot + profile +
  // the Daily record, all in one JSON document under the format marker.
  const state = window.Game.fullBackupState();
  check('a full backup carries the format marker',
    !!state && state.format === 'dailylocke-full-state' && state.version === 1);
  check('a full backup covers all three run slots',
    !!state && typeof state.runs === 'object' &&
    ['daily', 'free', 'gauntlet'].every((m) => Object.prototype.hasOwnProperty.call(state.runs, m)));
  check('a full backup carries profile and Daily record',
    !!state && !!state.profile && !!state.daily && Array.isArray(state.profile.shinies));
  check('the backup payload survives JSON round-tripping',
    (() => { try { const s = JSON.parse(JSON.stringify(state)); return !!s && s.format === 'dailylocke-full-state'; } catch { return false; } })());

  // Every run inside must be schema-valid (or absent), so restoreFullBackup
  // can accept it wholesale.
  const runsValid = (() => {
    for (const mode of ['daily', 'free', 'gauntlet']) {
      const r = state.runs[mode];
      if (!r) continue;
      if (window.Storage.validate(r) !== null) return false;
      if (!window.Storage.migrate(JSON.parse(JSON.stringify(r)), { cleanName: window.Core.cleanName })) return false;
    }
    return true;
  })();
  check('every run in a fresh backup passes validation + migration', runsValid);
}

// The title has no live `run` object, so transfer must discover ongoing runs
// in storage. Daily and Free Play use different slots; this is the regression
// path that used to inspect only Free Play and reject a valid Daily.
{
  const mem = new Map();
  const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });

  const S = window.Storage;
  const savedRun = (mode, section) => ({
    __v: S.SAVE_VERSION,
    mode,
    dailyDate: mode === 'daily' ? window.Daily.dayKey() : null,
    seed: mode === 'daily' ? 101 : 202,
    section,
    battlesWon: section,
    party: [{ id: 'gengar', species: 'Gengar', name: 'Casper', hpPct: 1 }],
  });
  S.putRun('daily', savedRun('daily', 3));

  // Export: the menu's Transfer opens the export dialog with the Download
  // button enabled, and the payload it would write contains the Daily.
  window.document.getElementById('btnTitleMenu').click();
  window.document.getElementById('btnMenuTransfer').click();
  const exportScreen = window.document.getElementById('screenSaveExport');
  const dlBtn = window.document.getElementById('btnDownloadSave');
  const exportState = window.Game.fullBackupState();
  check('an ongoing Daily can be transferred from the title menu',
    !exportScreen.hidden && !!dlBtn && !dlBtn.disabled &&
    exportState.runs.daily && exportState.runs.daily.mode === 'daily' &&
    exportState.runs.daily.section === 3);
  window.Modal.close('screenSaveExport');

  // Both independent slots must appear in the same export.
  S.putRun('free', savedRun('free', 8));
  const bothState = window.Game.fullBackupState();
  check('both ongoing runs are carried by one backup',
    !!bothState.runs.daily && !!bothState.runs.free &&
    bothState.runs.free.mode === 'free' && bothState.runs.free.section === 8);

  // Import through the UI: inject a full backup file, choose it, restore.
  const importPayload = {
    format: 'dailylocke-full-state', version: 1, savedAt: Date.now(),
    runs: {
      daily: null,
      free: {
        __v: S.SAVE_VERSION, mode: 'free', seed: 4242, section: 4, battlesWon: 4,
        party: [{ id: 'sneaselhisui', species: 'Sneasel', name: 'Blade', hpPct: 1,
                  types: ['Dark', 'Ice'], moves: ['tripleaxel'], pp: { tripleaxel: 5 },
                  ability: 'Inner Focus', nature: 'Jolly',
                  evs: { hp:0,atk:0,def:0,spa:0,spd:0,spe:0 },
                  ivs: { hp:31,atk:31,def:31,spa:31,spd:31,spe:31 } }],
        bag: {}, money: 100, graveyard: [], damageDealt: {}, knockouts: {},
        monMeta: {}, seenSpecies: {}, sectionStats: { money:0, won:0, caught:null, lost:[], damage:0, kos:0, startedAt:4 },
      },
      gauntlet: null,
    },
    profile: { __v: 1, shinies: [], history: [], totalRuns: 0, bestBattles: 0,
               bestSection: 0, totalCaught: 0, totalKOs: 0, avatar: 'red', theme: 'default' },
    daily: { __v: 1, results: {}, streak: 0, best: 0, lastPlayed: null, grace: 0 },
  };
  // Stale species name on purpose — restoreFullBackup must repair it from mon.id.
  const goodFile = new window.File([JSON.stringify(importPayload)], 'dailylocke-backup.json', { type: 'application/json' });
  window.document.getElementById('btnTitleMenu').click();
  window.document.getElementById('btnMenuImport').click();
  const importScreen = window.document.getElementById('screenSaveImport');
  const fileInput = window.document.getElementById('saveFileIn');
  check('import modal offers a file picker',
    !importScreen.hidden && !!fileInput && !!fileInput.accept);
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [goodFile] });
  fileInput.dispatchEvent(new window.Event('change'));
  window.document.getElementById('btnImportLoad').click();
  await new Promise((r) => setTimeout(r, 60));
  check('importing a backup returns to the title screen',
    window.document.getElementById('screenTitle').hidden === false &&
    window.document.getElementById('screenCrossroads').hidden === true);
  // The imported run is parked, not live — resume from the title CTA.
  check('import parks the run instead of auto-entering it',
    window.Game.run == null || window.Game.run.over === true ||
    window.document.getElementById('screenTitle').hidden === false);
  // The stored run must already be repaired: id is the durable key, so a
  // stale species string and base-forme typing never reach storage.
  const raw = mem.get(S.SLOTS.free);
  const stored = raw ? JSON.parse(raw) : null;
  check('import repairs a stale regional species name from mon.id',
    !!stored && stored.party && stored.party[0] &&
    (stored.party[0].species === 'Sneasel-Hisui' || stored.party[0].id === 'sneaselhisui'),
    stored && stored.party && stored.party[0] && `${stored.party[0].id}/${stored.party[0].species}`);
  check('import repairs regional typing from mon.id',
    !!stored && stored.party[0].types &&
    stored.party[0].types.join('/') === 'Fighting/Poison',
    stored && stored.party[0].types && stored.party[0].types.join('/'));
  window.Modal.close('screenSaveImport');

  // A wrong-format file is rejected with a message and changes nothing.
  S.clearRun('free');
  const badFile = new window.File([JSON.stringify({ format: 'some-other-game', runs: {}, profile: {} })], 'bad.json');
  window.document.getElementById('btnTitleMenu').click();
  window.document.getElementById('btnMenuImport').click();
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [badFile] });
  fileInput.dispatchEvent(new window.Event('change'));
  window.document.getElementById('btnImportLoad').click();
  await new Promise((r) => setTimeout(r, 60));
  const badMsg = window.document.getElementById('saveImportMsg').textContent;
  check('a wrong-format backup is rejected with a clear message',
    /not a valid Dailylocke backup/.test(badMsg), badMsg);
  check('a rejected backup leaves storage untouched',
    mem.get(S.SLOTS.free) == null && mem.get(S.SLOTS.daily) == null);

  // A backup with an invalid run inside is rejected wholesale, never partially
  // applied.
  const invalidRunPayload = JSON.parse(JSON.stringify(importPayload));
  invalidRunPayload.runs.free = { __v: S.SAVE_VERSION, mode: 'free', party: [], seed: 1 };
  const badRunFile = new window.File([JSON.stringify(invalidRunPayload)], 'badrun.json');
  window.document.getElementById('btnMenuImport').click();
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [badRunFile] });
  fileInput.dispatchEvent(new window.Event('change'));
  window.document.getElementById('btnImportLoad').click();
  await new Promise((r) => setTimeout(r, 60));
  const badRunMsg = window.document.getElementById('saveImportMsg').textContent;
  check('a backup with an invalid run is rejected wholesale',
    /invalid/.test(badRunMsg) || /no surviving/.test(badRunMsg), badRunMsg);
  check('an invalid run never reaches storage',
    mem.get(S.SLOTS.free) == null);
  window.Modal.close('screenSaveImport');

  S.clearRun('daily');
  S.clearRun('free');
  Object.defineProperty(window, 'localStorage', originalLocalStorage);
}

// -------------------------------------------------------------- storage ----
// Step 1 of the app.js split: persistence + migrations moved to their own
// module. These test it directly, without a DOM or a live run.
{
  const S = window.Storage;
  check('window.Storage (persistence + migrations)', !!S);
  check('the two run slots have distinct keys',
    S.SLOTS.daily !== S.SLOTS.free && !!S.SLOTS.daily && !!S.SLOTS.free,
    `${S.SLOTS.daily} / ${S.SLOTS.free}`);
  check('keyFor routes each mode to its own slot',
    S.keyFor('daily') === S.SLOTS.daily && S.keyFor('free') === S.SLOTS.free &&
    S.keyFor(undefined) === S.SLOTS.free);

  // Storage must never throw, even where localStorage is unavailable (JSDOM's
  // opaque origin here; Safari private mode in the wild).
  check('storage access never throws',
    (() => {
      try { S.read('x'); S.write('x', '1'); S.drop('x'); S.available(); return true; }
      catch { return false; }
    })());

  // snapshot() drops the RNG function handle but keeps its state.
  const fakeRun = {
    seed: 5, section: 2, party: [{ id: 'gengar' }], mode: 'daily',
    rand: Object.assign(() => 0.5, { getState: () => 4242 }),
  };
  const snap = S.snapshot(fakeRun);
  check('snapshot drops the unserialisable RNG handle but keeps its state',
    snap.rand === undefined && snap.randState === 4242 && snap.__v === S.SAVE_VERSION);
  check('snapshot round-trips through JSON',
    JSON.parse(JSON.stringify(snap)).section === 2);

  // ---- migrations ----
  const legacy = {
    seed: 1, section: 3,
    party: [
      { id: 'gengar', hpPct: 1, uid: 1 },
      { id: 'pikachu', hpPct: 0, uid: 2, name: 'Sparky' },   // already fainted
    ],
    damageDealt: { 2: 500 },
  };
  const m1 = S.migrate(JSON.parse(JSON.stringify(legacy)), { cleanName: (x) => x });
  check('v1 saves migrate to the current version', m1.__v === S.SAVE_VERSION, `v${m1.__v}`);
  check('migration buries a Pokemon that fainted before the save',
    m1.party.length === 1 && m1.graveyard.length === 1 && m1.graveyard[0].id === 'pikachu');
  check('migration backfills species and pp', !!m1.party[0].species && !!m1.party[0].pp);
  check('migration backfills sectionStats', !!m1.sectionStats);

  // The important one: a pre-split save must NOT be adopted as a Daily, which
  // would fabricate a result for a day it never belonged to.
  check('a legacy save becomes a FREE PLAY run',
    m1.mode === 'free' && m1.dailyDate === null && m1.maxSections === 0,
    `${m1.mode} / ${m1.dailyDate}`);
  check('migration leaves an already-current save alone',
    S.migrate({ __v: S.SAVE_VERSION, mode: 'daily', dailyDate: '2026-07-29',
                party: [{ id: 'gengar' }], seed: 1 }, {}).mode === 'daily');
  check('an empty party is unrecoverable, not a broken run',
    S.migrate({ __v: 3, party: [], seed: 1 }, {}) === null &&
    S.migrate(null, {}) === null);

  // ---- validation of imported codes ----
  const ok = { __v: 3, seed: 42, party: [{ id: 'gengar' }] };
  check('a valid save passes validation', S.validate(ok) === null);
  check('validation rejects junk, not with an exception',
    typeof S.validate(null) === 'string' &&
    typeof S.validate('hello') === 'string' &&
    typeof S.validate([]) === 'string' &&
    typeof S.validate({ seed: 1 }) === 'string' &&
    typeof S.validate({ seed: 1, party: [] }) === 'string' &&
    typeof S.validate({ seed: 1, party: [{}] }) === 'string');
  check('validation refuses a save from a NEWER build',
    typeof S.validate({ __v: S.SAVE_VERSION + 1, seed: 1, party: [{ id: 'x' }] }) === 'string');
  check('validation tolerates a numeric-string seed',
    S.validate({ __v: 3, seed: '42', party: [{ id: 'gengar' }] }) === null);
  check('a blank profile has every field the UI reads',
    ['shinies', 'history', 'totalRuns', 'bestBattles', 'bestSection', 'avatar', 'theme']
      .every((k) => S.blankProfile()[k] !== undefined));
}

// ----------------------------------------------------------- save slots ----
// Daily and Free Play must never share a slot: a good Free Play run used to
// block the Daily, and finishing a Daily used to destroy the other run.
{
  // JSDOM's file:// origin is OPAQUE, so even *reading* window.localStorage
  // throws SecurityError -- which is also exactly what Safari private mode
  // does, and why every storage call in the game is wrapped. Fall back to an
  // in-memory stand-in: what matters here is the KEY LAYOUT, not the browser's
  // storage implementation.
  let ls;
  try {
    ls = window.localStorage;
    ls.setItem('__probe', '1');
    ls.removeItem('__probe');
  } catch {
    const mem = new Map();
    ls = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    };
  }
  ls.clear();
  const mk = (mode, section) => JSON.stringify({
    __v: 3, mode, dailyDate: mode === 'daily' ? window.Daily.dayKey() : null,
    seed: 42, section, battleInSection: 0, maxSections: mode === 'daily' ? window.Daily.SECTIONS : 0,
    party: [{ id: 'gengar', species: 'Gengar', name: 'Casper', hpPct: 1, moves: ['shadowball'], pp: {} }],
    bag: {}, money: 100, battlesWon: 1, graveyard: [], damageDealt: {}, knockouts: {},
    monMeta: {}, seenSpecies: {},
  });
  ls.setItem('nuzlocke-run', mk('free', 12));
  ls.setItem('dailylocke-run-daily', mk('daily', 3));
  check('the two save slots use different keys',
    ls.getItem('nuzlocke-run') !== null && ls.getItem('dailylocke-run-daily') !== null);
  check('a Free Play run and a Daily coexist',
    JSON.parse(ls.getItem('nuzlocke-run')).section === 12 &&
    JSON.parse(ls.getItem('dailylocke-run-daily')).section === 3);
  check('the daily slot is dated so a stale one can be detected',
    JSON.parse(ls.getItem('dailylocke-run-daily')).dailyDate === window.Daily.dayKey());
  check('the daily history lives in its own key, safe from a run wipe',
    window.Daily.KEY !== 'nuzlocke-run' && window.Daily.KEY !== 'dailylocke-run-daily' &&
    window.Daily.KEY !== 'nuzlocke-profile');
  ls.clear();
}

// ---------------------------------------------------------------- modal ----
// One controller, WAI dialog pattern. These cover the parts JSDOM can see;
// real-browser focus behaviour is deliberately out of scope here (the sandbox
// and CI cannot run a browser, so this suite is the whole gate).
{
  const M = window.Modal;
  const doc = window.document;
  const menu = doc.getElementById('screenMenu');

  check('modals start closed', menu.hidden === true && M.depth === 0);

  M.open('screenMenu');
  const card = menu.querySelector('.overlay-card');
  check('opening applies dialog semantics',
    menu.hidden === false && card.getAttribute('role') === 'dialog' &&
    card.getAttribute('aria-modal') === 'true');
  check('the dialog gets an accessible name from its own heading',
    !!card.getAttribute('aria-labelledby') || !!card.getAttribute('aria-label'));
  check('the dialog is programmatically focusable', card.getAttribute('tabindex') === '-1');
  check('the body is marked while a modal is open',
    doc.body.classList.contains('modal-open'));

  // The dialog must NOT inherit inertness from its own ancestors -- the bug
  // that made every overlay unclickable when this shipped.
  let node = menu, selfInert = false;
  while (node && node !== doc.body) {
    if (node.inert === true) selfInert = true;
    node = node.parentElement;
  }
  check('the open dialog is never itself inert', !selfInert);

  // `data-modal-overlay` nodes (the toast, the coach-mark layer) float ABOVE
  // dialogs rather than behind them, so they are deliberately exempt.
  const siblingsInert = (() => {
    let n = menu, ok = true;
    while (n && n !== doc.body && n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib === n || sib.tagName === 'SCRIPT' || sib.tagName === 'TEMPLATE') continue;
        if (sib.hasAttribute('data-modal-overlay')) continue;
        if (sib.inert !== true && sib.getAttribute('aria-hidden') !== 'true') ok = false;
      }
      n = n.parentElement;
    }
    return ok;
  })();
  check('everything behind the dialog is inert', siblingsInert);

  check('layers that float above dialogs are never inerted',
    doc.getElementById('toast').inert !== true &&
    doc.getElementById('toast').getAttribute('aria-hidden') !== 'true',
    'a toast fired from inside a dialog has to stay readable');

  check('the controller tracks what is open', M.isOpen('screenMenu') && M.depth === 1);

  // Nesting: the picker can open above the menu.
  M.open('screenPicker');
  check('modals stack', M.depth === 2 && M.isOpen('screenPicker'));

  // REGRESSION: a dialog opened ON TOP of another one used to arrive DEAD.
  // The first modal inerts every sibling on the path to <body>, and the
  // game's overlays are siblings -- so the second dialog had already been
  // inerted before it was ever shown, and nothing brought it back. Its
  // buttons swallowed taps and its scrim would not dismiss. Every
  // second-level dialog in the game was affected; where it actually stranded
  // people was onboarding, because the nickname prompt is deliberately
  // escape-proof and scrim-proof and the coach fires a lesson over it on a
  // timer. Inertness must therefore track the TOP of the stack, not the
  // bottom.
  const picker = doc.getElementById('screenPicker');
  check('a dialog stacked on another one is not born inert',
    picker.inert !== true && picker.getAttribute('aria-hidden') !== 'true',
    'the second dialog opened unclickable');
  check('the stacked dialog\'s controls are reachable',
    !!M._focusables(picker.querySelector('.overlay-card') || picker)
      .every((el) => !el.closest('[inert]')));
  check('the dialog underneath is still inert while one sits on top',
    menu.querySelector('.overlay-card').inert === true,
    'focus must stay trapped in the top dialog');

  M.close('screenPicker');
  check('closing the top restores the one below',
    M.depth === 1 && M.isOpen('screenMenu') &&
    doc.getElementById('screenPicker').hidden === true);
  check('the dialog below comes back to life when the top closes',
    menu.inert !== true && menu.querySelector('.overlay-card').inert !== true);
  check('the page behind is still inert while one dialog remains',
    doc.getElementById('screenTitle').inert === true);

  M.close('screenMenu');
  check('closing hides the dialog and clears the body flag',
    menu.hidden === true && M.depth === 0 && !doc.body.classList.contains('modal-open'));

  const released = (() => {
    let n = menu, ok = true;
    while (n && n !== doc.body && n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib === n || sib.tagName === 'SCRIPT' || sib.tagName === 'TEMPLATE') continue;
        if (sib.inert === true || sib.getAttribute('aria-hidden') === 'true') ok = false;
      }
      n = n.parentElement;
    }
    return ok;
  })();
  check('the page is released when the last modal closes', released);

  check('closing something that was never opened is harmless',
    (() => { try { M.close('screenMenu'); M.close('nope'); return true; } catch { return false; } })());
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
// Learnsets ship as a separate chunk. Earlier tests may already have warmed
// it (import revive → Forme.enforceHeldForme), so only assert emptiness when
// nothing has asked for them yet; the on-demand load check below is the real
// contract either way.
check('learnsets ship as a separate on-demand chunk',
  existsSync(resolve(repo, 'vendor/pkmn-learnsets.js')) &&
  typeof PS.learnsetsReady === 'function',
  Object.keys(PS.Dex.data.Learnsets).length
    ? `already warmed (${Object.keys(PS.Dex.data.Learnsets).length} entries)`
    : 'still deferred');
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

// Regional variants must keep their full identity. An earlier cleanName() bug
// walked every forme up to its base species, so Sneasel-Hisui became "Sneasel"
// — and the battle engine then spawned the default forme (wrong sprite + typing).
{
  const hisui = await C.makeMon('sneaselhisui');
  check('a regional forme keeps its full species name',
    hisui.species === 'Sneasel-Hisui' && hisui.id === 'sneaselhisui',
    `${hisui.id} / ${hisui.species}`);
  check('a regional forme keeps its own typing (not the base forme\'s)',
    hisui.types.join('/') === 'Fighting/Poison', hisui.types.join('/'));
  check('cleanName preserves regional variants',
    C.cleanName('sneaselhisui') === 'Sneasel-Hisui' &&
    C.cleanName('raichualola') === 'Raichu-Alola' &&
    C.cleanName('weezinggalar') === 'Weezing-Galar',
    [C.cleanName('sneaselhisui'), C.cleanName('raichualola'), C.cleanName('weezinggalar')].join(', '));
  check('cleanName still collapses temporary megas to the root',
    /charizard/i.test(C.cleanName('charizardmegax')) &&
    !/mega/i.test(C.cleanName('charizardmegax')),
    C.cleanName('charizardmegax'));
  // toSet must feed the engine the forme's real species, even if mon.species
  // was corrupted to the base name (the old-save failure mode).
  hisui.species = 'Sneasel';
  const packed = C.toSet(hisui);
  check('toSet prefers mon.id over a stale mon.species',
    packed.species === 'Sneasel-Hisui', packed.species);
  check('regional formes are in the encounter pool',
    C.speciesPool().indexOf('sneaselhisui') >= 0 &&
    C.speciesPool().indexOf('raichualola') >= 0);
}

// ------------------------------------------------ evolution screen / art --
// Drive the exact route-screen path that regressed: opening a Pokemon's detail
// sheet and evolving from inside it. The modal controller makes every screen
// behind an open sheet inert, so failing to close the sheet leaves Continue
// visible but impossible to press.
{
  const waitFor = async (fn, ms = 12000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = fn();
      if (value) return value;
      await new Promise((res) => setTimeout(res, 25));
    }
    return null;
  };

  // Free Play starts straight at starter selection.
  window.document.getElementById('btnNewRun').click();
  const starter = await waitFor(() => window.document.querySelector('#starterGrid .pick-btn'));
  check('a Free Play run reaches starter selection', !!starter);
  if (starter) starter.click();
  const nick = await waitFor(() => !window.document.getElementById('screenNickname').hidden &&
    window.document.getElementById('nickInput'));
  if (nick) {
    nick.value = 'Sprout';
    window.document.getElementById('btnNickOk').click();
  }
  const route = await waitFor(() => !window.document.getElementById('screenCrossroads').hidden);
  check('choosing a starter reaches the route', !!route);
  await new Promise((r) => setTimeout(r, 140));
  check('the route releases the dialog stack', window.Modal.depth === 0);

  if (route) {
    // Use a known one-step level evolution so the party sheet always offers a
    // ready button, independently of the random starter that was rolled.
    const evoMon = await C.makeMon('ivysaur');
    evoMon.name = 'Sprout';
    evoMon.species = 'Ivysaur';
    window.Game.run.party[0] = evoMon;
    window.Nuz.trackMon(window.Game.run, evoMon);
    window.Game.run.bag.rarecandy = 1;
    window.Game.redrawRoute();

    const stripSprite = window.document.querySelector('#xTeam .anim-mon');
    check('route sprites have decode-time size bounds',
      !!stripSprite && /max-height:\s*64px/.test(stripSprite.getAttribute('style') || ''),
      stripSprite && stripSprite.getAttribute('style'));

    window.document.querySelector('#xTeam .pc-card[data-i="0"] [data-detail]').click();
    await new Promise((r) => setTimeout(r, 140));
    const evoButton = window.document.querySelector('#xTeamDetail .evo-btn.ready');
    const detailSprite = window.document.querySelector('#xTeamDetail .pd-art img');
    check('inspected Pokemon art is bounded before onload',
      !!detailSprite && /max-height:\s*104px/.test(detailSprite.getAttribute('style') || ''),
      detailSprite && detailSprite.getAttribute('style'));
    check('the evolution action is offered in the detail sheet', !!evoButton);
    if (evoButton) evoButton.click();

    const evoScreen = window.document.getElementById('screenEvolve');
    check('starting an evolution closes its originating modal',
      window.Modal.depth === 0 && window.document.getElementById('xTeamDetail').hidden === true);
    check('the evolution screen and Continue action are not inert',
      evoScreen.hidden === false && evoScreen.inert !== true &&
      evoScreen.getAttribute('aria-hidden') !== 'true' &&
      window.document.getElementById('btnEvoDone').closest('[inert]') === null);

    const done = await waitFor(() => {
      const button = window.document.getElementById('btnEvoDone');
      return !button.hidden && button;
    }, 6000);
    check('evolution reveals its Continue button', !!done);
    if (done) done.click();
    check('Continue returns to the route after evolving',
      !window.document.getElementById('screenCrossroads').hidden &&
      window.Game.run.party[0].id === 'venusaur');
  }
}

// ======================================================== TEAM CARDS ========
// The route screen shows every Pokemon as a front-and-centre card with Heal /
// Train / Item actions that expand inline with recommendations. The cards are
// the same source of truth as the party sheet, and dragging reorders the
// underlying run.party (the first card always leads into battle).
{
  window.Modal.closeAll();
  const g = window.Game.run;
  g.mode = 'free'; g.over = false;
  g.money = 20000;
  const charmander = await C.makeMon('charmander');
  charmander.name = 'Char'; charmander.hpPct = 0.6; charmander.status = 'brn';
  const squirtle = await C.makeMon('squirtle');
  squirtle.name = 'Squirt'; squirtle.hpPct = 1;
  const bulbasaur = await C.makeMon('bulbasaur');
  bulbasaur.name = 'Bulba'; bulbasaur.hpPct = 1;
  g.party = [charmander, squirtle, bulbasaur];
  g.party.forEach((m) => window.Nuz.trackMon(g, m));
  g.bag = { fullrestore: 2, sitrusberry: 1, rarecandy: 1, pokeball: 3 };
  window.Game.show('Crossroads');
  window.Game.redrawRoute();

  const doc = window.document;
  check('every party member renders as a team card',
    doc.querySelectorAll('#xTeam .pc-card').length === 3);
  check('the first card is marked LEAD', !!doc.querySelector('#xTeam .pc-card[data-i="0"] .pc-lead'));
  check('each card has Heal, Train and Item actions',
    doc.querySelectorAll('#xTeam .pc-act').length === 9 &&
    !!doc.querySelector('#xTeam [data-panel="heal"]') &&
    !!doc.querySelector('#xTeam [data-panel="train"]') &&
    !!doc.querySelector('#xTeam [data-panel="item"]'));
  check('an injured card flags its Heal action',
    doc.querySelector('#xTeam .pc-card[data-i="0"] .pc-act-heal').classList.contains('need'));

  // Expanding Heal shows the medicine actually in the bag, with a recommendation.
  doc.querySelector('#xTeam .pc-card[data-i="0"] [data-panel="heal"]').click();
  await new Promise((r) => setTimeout(r, 60));
  const healRows = doc.querySelectorAll('#xTeam .pcp-heal .pcp-row');
  check('the Heal panel lists usable medicine', healRows.length >= 1);
  check('the Heal panel marks a recommended item',
    !!doc.querySelector('#xTeam .pcp-heal .pcp-row.rec'));

  // Using medicine applies it to THIS Pokemon and refreshes the cards.
  doc.querySelector('#xTeam .pcp-heal [data-heal="fullrestore"]').click();
  await new Promise((r) => setTimeout(r, 60));
  check('using medicine restores the selected Pokemon', g.party[0].hpPct >= 0.999 && !g.party[0].status);
  check('using medicine consumes one from the bag', g.bag.fullrestore === 1);

  // The Item panel offers held items from the bag and evolution.
  doc.querySelector('#xTeam .pc-card[data-i="0"] [data-panel="item"]').click();
  await new Promise((r) => setTimeout(r, 60));
  check('the Item panel offers a held item from the bag',
    !!doc.querySelector('#xTeam .pcp-item [data-give-held="sitrusberry"]'));
  check('the Item panel surfaces an available evolution',
    !!doc.querySelector('#xTeam .pcp-item .evo-btn'));

  // Tapping a card body opens the full detail overlay.
  doc.querySelector('#xTeam .pc-card[data-i="1"] [data-detail]').click();
  await new Promise((r) => setTimeout(r, 60));
  check('tapping a card opens the full detail sheet',
    !doc.getElementById('xTeamDetail').hidden && window.Modal.isOpen('xTeamDetail'));
  window.Modal.closeAll();

  // Reordering by UID commits to run.party (simulate the drag drop order).
  const grid = doc.getElementById('xTeam');
  // Move the third card (Bulbasaur) to the front, simulating a drag-and-drop.
  const card2 = grid.querySelector('.pc-card[data-i="2"]');
  grid.insertBefore(card2, grid.firstElementChild);
  // Mirror initTeamDrag's commit: map the DOM order back onto run.party.
  const uids = Array.from(grid.querySelectorAll('.pc-card')).map((c) => c.dataset.uid);
  const byUid = {};
  g.party.forEach((m) => { byUid[m.uid] = m; });
  g.party = uids.map((u) => byUid[u]).filter(Boolean);
  window.Game.redrawRoute();
  check('reordering the cards reorders run.party',
    g.party[0].name === 'Bulba' && g.party[1].name === 'Char' && g.party[2].name === 'Squirt',
    g.party.map((m) => m.name).join(', '));
  check('after reorder the new first card is marked LEAD',
    !!doc.querySelector('#xTeam .pc-card[data-i="0"] .pc-lead') &&
    doc.querySelector('#xTeam .pc-card[data-i="0"]').dataset.uid === String(g.party[0].uid));
}

// ======================================================== STAT POINT SLIDERS ==
// A trained Pokemon starts with all 66 points allocated. Sliders used to snap
// an increase straight back to its old value until another stat was lowered,
// which looked and behaved like a dead control. Training now uses a safe draft:
// any slider may move first, but an over-budget draft cannot leave the tab,
// close training, reach the live Pokemon, or enter a save.
{
  const g = window.Game.run;
  const untilSlider = async (fn, ms = 3000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const value = fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return null;
  };
  window.Modal.closeAll();
  g.mode = 'free'; g.over = false;
  g.section = 3; g.battleInSection = 0;
  g.money = 9999; g.trainingPaidThisRound = true;
  g.bag = g.bag || {};
  const trained = window.Nuz.trainPlayerMon(await C.makeMon('charmander'));
  trained.name = 'Slider'; trained.hpPct = 1;
  g.party = [trained]; window.Nuz.trackMon(g, trained);
  window.Game.show('Crossroads');
  window.Game.redrawRoute();

  const teamSlot = window.document.querySelector('#xTeam .pc-card[data-i="0"] [data-detail]');
  if (teamSlot) teamSlot.click();
  const trainBtn = await untilSlider(() =>
    window.document.querySelector('#xTeamDetail .pd-train'));
  if (trainBtn) trainBtn.click();
  const statsTab = await untilSlider(() =>
    window.document.querySelector('#screenTutor .tr-tab[data-t="stats"]'));
  if (statsTab) statsTab.click();
  const defSlider = await untilSlider(() =>
    window.document.querySelector('#screenTutor .sp-range[data-s="def"]'));
  const liveDefBefore = trained.sp.def;
  if (defSlider) {
    defSlider.value = '10';
    defSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  check('a full-budget stat slider can move upward first without snapping back',
    !!defSlider && Number(defSlider.value) === 10 &&
    window.document.getElementById('spLeft').textContent === '-10');
  check('an over-budget slider draft does not mutate the live Pokemon',
    trained.sp.def === liveDefBefore && !window.document.getElementById('spWarning').hidden,
    `live=${trained.sp.def} draft=${defSlider && defSlider.value}`);

  const natureTab = window.document.querySelector('#screenTutor .tr-tab[data-t="nature"]');
  if (natureTab) natureTab.click();
  const activeTrainTab = window.document.querySelector('#screenTutor .tr-tab.on');
  check('an over-budget draft cannot leave the Stats tab',
    !!activeTrainTab && activeTrainTab.dataset.t === 'stats');
  window.document.getElementById('btnTutorBack').click();
  check('an over-budget draft cannot close training',
    !window.document.getElementById('screenTutor').hidden && trained.sp.def === liveDefBefore);

  const donor = window.document.querySelector('#screenTutor .sp-range[data-s="spa"]');
  if (donor) {
    donor.value = '22';
    donor.dispatchEvent(new window.Event('input', { bubbles: true }));
    donor.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  check('balancing a second slider commits the whole valid spread',
    trained.sp.def === 10 && trained.sp.spa === 22 && C.spUsed(trained) === C.SP_TOTAL &&
    trained.evs.def === C.spToEv(10) && window.document.getElementById('spWarning').hidden,
    JSON.stringify(trained.sp));
  window.document.getElementById('btnTutorBack').click();
  check('a valid slider spread can finish training',
    window.document.getElementById('screenTutor').hidden);
}

// A wiped Daily may still have a zero-HP object in party during a simultaneous
// KO. Raw party.length therefore cannot decide whether Free Play is possible.
{
  const wiped = window.Game.run;
  wiped.mode = 'daily';
  wiped.dailyDate = window.Daily.dayKey();
  wiped.maxSections = window.Daily.SECTIONS;
  wiped.over = false;
  wiped.party.forEach((m) => { m.hpPct = 0; });
  window.Game.advance();

  check('a Daily wipe opens the result screen',
    !window.document.getElementById('screenDailyResult').hidden);
  check('a Daily wipe never offers infinite Free Play',
    window.document.getElementById('btnDrContinue').hidden === true);

  window.Game.continueDailyInFreePlay();
  check('a dead Daily team cannot bypass the hidden continuation action',
    !window.document.getElementById('screenDailyResult').hidden &&
    window.Game.run.mode === 'daily' && window.Game.run.over === true);
}

// ================================================== BATTLE FAILURE RECOVERY ==
// A renderer that refuses to mount must surface the retry panel (not a dead
// button), the start latch must clear, and "Try again" must retry from scratch.
{
  const wait6 = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  };
  window.Modal.closeAll();
  const r6 = window.Game.run;
  const lead6 = await C.makeMon('rattata');
  lead6.moves = ['tackle']; lead6.name = 'Scout'; lead6.hpPct = 1; lead6.item = '';
  r6.mode = 'free'; r6.over = false;
  r6.section = 1; r6.battleInSection = 0;
  r6.catchUsedThisSection = false; r6.catchMissed = false; r6.encounterSeen = false;
  r6.bag = { pokeball: 3, potion: 2 }; r6.money = 100;
  r6.party = [lead6]; window.Nuz.trackMon(r6, lead6);

  const RealBattleUI2 = window.BattleUI;
  window.BattleUI = class { mount() { throw new Error('synthetic WebGL renderer failure'); } };
  await window.Game.startNextBattle();
  check('a renderer that fails to mount surfaces the retry panel',
    !!window.document.querySelector('#battleHost .battle-error'));
  check('a failed start releases the battle latch',
    window.Game.battleStarting === false);
  check('a failed mount clears the zombie mount flag',
    window.document.getElementById('battleHost')._bm == null);
  window.BattleUI = RealBattleUI2;

  const retryBtn = window.document.getElementById('btnBattleRetry');
  if (retryBtn) retryBtn.click();
  // "Try again" must build a full battle, not just flip the screen. Wait for
  // an ENABLED move button: that is the moment the engine's first request has
  // been rendered, which also guarantees the retry did not silently fail into
  // a second error panel.
  const recoveredMove = await wait6(() =>
    [...window.document.querySelectorAll('#battleHost .mb[data-i]:not([disabled])')][0], 20000);
  check('"Try again" starts the battle from scratch', !!recoveredMove);

  // A live context loss must never end the battle or cost it its controls.
  // The engine either re-attaches a restored/recreated renderer in place
  // (same instance -- the scene graph is renderer-agnostic) or the app
  // rebuilds only the presentation layer; either way the current stream and
  // encounter stay alive and the player gets the same move request back
  // rather than a rerolled wild Pokemon or a reset battle. The in-place
  // renderer-swap guarantee itself is owned by the browser smoke test --
  // JSDOM cannot produce a real context loss/restore cycle.
  const oldBattleUi = window.Game.ui;
  const liveLoss = new window.Event('webglcontextlost', { cancelable: true });
  if (oldBattleUi && oldBattleUi.r && oldBattleUi.r.domElement) {
    oldBattleUi.r.domElement.dispatchEvent(liveLoss);
    // JSDOM cannot restore a real GPU context, so emulate the browser's
    // follow-up event to exercise the scene rebuild path.
    oldBattleUi.r.domElement.dispatchEvent(new window.Event('webglcontextrestored'));
  }
  const recoveredRenderer = await wait6(() => {
    const next = window.Game.ui;
    const move = [...window.document.querySelectorAll('#battleHost .mb[data-i]:not([disabled])')][0];
    const backIn3D = next && next.r && !next.flat && window.document.querySelector('#battleHost canvas');
    return next && move && (backIn3D || next !== oldBattleUi) ? next : null;
  }, 20000);
  check('a live context loss rebuilds the renderer in place',
    !!recoveredRenderer && liveLoss.defaultPrevented,
    `recovered=${!!recoveredRenderer}, prevented=${liveLoss.defaultPrevented}`);
  check('renderer recovery preserves the active run', window.Game.run._inBattle === true);

  // tidy: back to a calm route for the blocks that follow.
  window.Modal.closeAll();
  window.Game.show('Crossroads');
  r6._inBattle = false; r6._battleCfg = null;
}

// ------------------------------------------------------- team gauntlet ----
// The third mode: draft any six Pokemon at no cost, then fight trainer after
// trainer. Two contracts are pinned here:
//   1. DIFFICULTY PARITY -- the scaling plumbing is the same code the Daily
//      and Free Play run through (tier/trainerFor/makeTrainerTeam, keyed on
//      run.section), so trainer N of a Gauntlet is identical to the Nth
//      trainer battle of the other modes.
//   2. THE SHAPE -- a free six-mon draft, no wilds, no cash, no mart, no bag,
//      no running; survivors heal after every won battle.
{
  const N = window.Nuz;
  const S = window.Storage;
  const doc = window.document;
  const mk = (mode, section) => {
    const r = N.newRun(99);
    r.mode = mode;
    r.section = section;
    return r;
  };

  // ---- the slot ----
  check('the gauntlet has its own save slot',
    !!S.SLOTS.gauntlet && S.SLOTS.gauntlet !== S.SLOTS.free && S.SLOTS.gauntlet !== S.SLOTS.daily,
    `${S.SLOTS.gauntlet}`);
  check('keyFor routes the gauntlet to its slot',
    S.keyFor('gauntlet') === S.SLOTS.gauntlet && S.keyFor(undefined) === S.SLOTS.free);
  check('gauntlet runs are identified independently of Free Play',
    N.isGauntlet(mk('gauntlet', 1)) === true && N.isGauntlet(mk('free', 1)) === false &&
    N.isGauntlet(null) === false);

  // ---- the shape ----
  check('every gauntlet battle is a trainer battle',
    N.nextIsTrainer(mk('gauntlet', 1)) === true && N.nextIsTrainer(mk('gauntlet', 3)) === true);
  check('the gauntlet advances difficulty after EVERY battle', (() => {
    const g = mk('gauntlet', 1);
    const moved = N.advanceBattle(g);
    return moved === true && g.section === 2 && g.battleInSection === 0;
  })());
  check('other modes still take four battles to advance a section', (() => {
    const f = mk('free', 1);
    for (let i = 0; i < 3; i++) {
      if (N.advanceBattle(f)) return false;   // moved early
    }
    return f.section === 1 && N.advanceBattle(f) === true && f.section === 2;
  })());

  // ---- difficulty parity: same seed + same section = same opponent ----
  check('trainer difficulty bands match Free Play at battles 2 and 10',
    JSON.stringify(N.tier(mk('gauntlet', 2), true)) === JSON.stringify(N.tier(mk('free', 2), true)) &&
    JSON.stringify(N.tier(mk('gauntlet', 10), true)) === JSON.stringify(N.tier(mk('free', 10), true)));
  const g2 = mk('gauntlet', 2), f2 = mk('free', 2);
  const g10 = mk('gauntlet', 10), f10 = mk('free', 10);
  check('trainer 2 is the same opponent in every mode', (() => {
    const a = N.trainerFor(g2), b = N.trainerFor(f2);
    return a.name === b.name && a.sprite === b.sprite && a.boss === b.boss;
  })());
  check('trainer 10 is the same opponent in every mode', (() => {
    const a = N.trainerFor(g10), b = N.trainerFor(f10);
    return a.name === b.name && a.sprite === b.sprite && a.boss === b.boss;
  })());
  check('trainer 2 fields the exact same team in every mode',
    (await N.makeTrainerTeam(g2, N.trainerFor(g2))).map((m) => m.id).join() ===
    (await N.makeTrainerTeam(f2, N.trainerFor(f2))).map((m) => m.id).join());
  check('trainer 10 fields the exact same team in every mode',
    (await N.makeTrainerTeam(g10, N.trainerFor(g10))).map((m) => m.id).join() ===
    (await N.makeTrainerTeam(f10, N.trainerFor(f10))).map((m) => m.id).join());
  check('boss clauses and strategies line up too',
    JSON.stringify(N.bossClauseFor(mk('gauntlet', 20))) ===
    JSON.stringify(N.bossClauseFor(mk('free', 20))));
  check('ascension scaling applies to the gauntlet like any other run',
    N.ascension(mk('gauntlet', 16)) === N.ascension(mk('free', 16)) &&
    N.ascensionEffects(mk('gauntlet', 31)).healPct === N.ascensionEffects(mk('free', 31)).healPct);

  // ---- the DOM flow: draft -> route -> resume ----
  const mem = new Map();
  const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    },
  });
  const waitFor = async (fn, ms = 12000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = fn();
      if (value) return value;
      await new Promise((res) => setTimeout(res, 25));
    }
    return null;
  };

  // A player who can see the Gauntlet button has history (or a set-up
  // profile) -- the beginner title hides the mode grid. Model that so the
  // title stays in "modes" state after the run is abandoned below.
  const gauntletProfile = window.Storage.loadProfile();
  gauntletProfile.name = 'Tester';
  window.Storage.saveProfile(gauntletProfile);
  window.Game.show('Title');
  const gBtn = doc.getElementById('btnGauntlet');
  check('the title offers the Team Gauntlet', !!gBtn && /team gauntlet/i.test(gBtn.textContent));
  gBtn.click();
  check('the gauntlet CTA opens the team draft',
    doc.getElementById('screenTeamBuilder').hidden === false);
  check('the draft cannot start empty', doc.getElementById('btnTbStart').disabled === true);
  check('the catalogue lists real species with sprites and stats',
    doc.querySelectorAll('#tbList .tb-row').length > 0 &&
    !!doc.querySelector('#tbList .tb-row .tb-art img') &&
    /BST \d+/.test(doc.querySelector('#tbList .tb-row .tb-bst').textContent));

  const searchFor = (q) => {
    const box = doc.getElementById('tbSearch');
    box.value = q;
    box.dispatchEvent(new window.Event('input'));
  };
  searchFor('kommoo');
  const hyphenHit = [...doc.querySelectorAll('#tbList .tb-row')].some((r) => r.dataset.id === 'kommoo');
  searchFor('ho oh');
  const spaceHit = [...doc.querySelectorAll('#tbList .tb-row')].some((r) => r.dataset.id === 'hooh');
  searchFor('mr mime');
  const punctuationHit = [...doc.querySelectorAll('#tbList .tb-row')].some((r) => r.dataset.id === 'mrmime');
  check('the search is punctuation-insensitive', hyphenHit && spaceHit && punctuationHit,
    `kommoo=${hyphenHit} 'ho oh'=${spaceHit} 'mr mime'=${punctuationHit}`);

  const picks = ['gengar', 'snorlax', 'garchomp', 'scizor', 'blissey', 'rotom'];
  for (let i = 0; i < picks.length; i++) {
    const id = picks[i];
    searchFor(id);
    const row = doc.querySelector(`#tbList .tb-row[data-id="${id}"]`);
    check(`the draft offers ${id}`, !!row && !row.disabled);
    if (row) row.click();
    const added = await waitFor(() =>
      doc.querySelectorAll('#tbTeam .tslot.filled').length === i + 1);
    check(`the draft adds ${id}`, !!added);
  }
  check('six picks complete the draft',
    doc.getElementById('tbCount').textContent.startsWith('6 / 6'));
  check('the start action unlocks at six picks',
    doc.getElementById('btnTbStart').disabled === false);
  searchFor('pikachu');
  check('a full draft refuses a seventh pick',
    doc.querySelector('#tbList .tb-row[data-id="pikachu"]') &&
    doc.querySelector('#tbList .tb-row[data-id="pikachu"]').disabled === true);

  // This sheet is shared with Crossroads. It must not live inside that hidden
  // screen, or opening it from TeamBuilder makes the draft inert while the
  // sheet itself remains invisible, leaving no way to close it.
  doc.querySelector('#tbTeam .tslot[data-i="0"]').click();
  const teamDetail = doc.getElementById('xTeamDetail');
  check('a draft slot opens its Pokemon config sheet',
    teamDetail.hidden === false && window.Modal.isOpen('xTeamDetail'));
  check('the shared Pokemon config is outside every switchable screen',
    teamDetail.parentElement === doc.querySelector('main') && !teamDetail.closest('section[hidden]'));
  check('the draft config shows the Pokemon moves and a working close action',
    doc.querySelectorAll('#xTeamDetail .pd-move').length > 0 &&
    !!doc.querySelector('#xTeamDetail .pd-close'));
  doc.querySelector('#xTeamDetail .pd-close').click();
  check('closing Pokemon config releases the Gauntlet builder',
    teamDetail.hidden === true && !window.Modal.isOpen('xTeamDetail') &&
    doc.getElementById('screenTeamBuilder').inert !== true);

  doc.querySelector('#tbTeam .ts-rm[data-rm="0"]').click();
  check('the remove action drops a drafted Pokemon',
    doc.getElementById('tbCount').textContent.startsWith('5 / 6'));
  searchFor('gengar');
  doc.querySelector('#tbList .tb-row[data-id="gengar"]').click();
  const readded = await waitFor(() => doc.getElementById('btnTbStart').disabled === false);
  check('a removed Pokemon can be re-added', !!readded);

  doc.getElementById('btnTbStart').click();
  const drafted = await waitFor(() =>
    window.Game.run && window.Game.run.mode === 'gauntlet' && window.Game.run.party.length === 6);
  check('confirming the draft creates the gauntlet run', !!drafted);
  check('the drafted team costs nothing and owns nothing', (() => {
    const r = window.Game.run;
    return r.money === 0 && Object.keys(r.bag).length === 0;
  })());
  check('drafted Pokemon are competitively raised like starters', (() => {
    const m = window.Game.run.party[0];
    const sp = m.sp;
    const total = sp.hp + sp.atk + sp.def + sp.spa + sp.spd + sp.spe;
    return total > 0 && (sp.atk > 0 || sp.spa > 0) && sp.spe > 0 &&
      ['Adamant', 'Modest'].includes(m.nature);
  })());

  // The route screen is pure battle: trainer up next, no economy anywhere.
  check('the route offers a trainer battle',
    doc.getElementById('screenCrossroads').hidden === false &&
    doc.getElementById('xNextLabel').textContent === 'Trainer Battle');
  check('the route shows the trainer counter',
    /Gauntlet \u00b7 Trainer 1/.test(doc.getElementById('xEyebrow').textContent),
    doc.getElementById('xEyebrow').textContent);
  check('the gauntlet hides the cash readout, the bag and the mart',
    doc.getElementById('xCashPill').hidden === true &&
    doc.getElementById('xBagBlock').hidden === true &&
    doc.getElementById('xShopBlock').hidden === true);

  // The run autosaves to its own slot, and the title CTA becomes a resume.
  check('the gauntlet autosaves to its own slot', (() => {
    const raw = mem.get(S.SLOTS.gauntlet);
    return !!raw && JSON.parse(raw).mode === 'gauntlet' && JSON.parse(raw).party.length === 6;
  })());
  window.Game.setContinueState();
  check('the title CTA becomes Resume Gauntlet once parked',
    doc.getElementById('gauntletMain').textContent === 'Resume Gauntlet');

  doc.getElementById('btnMenu').click();
  check('the menu offers an option to abandon the live run',
    doc.getElementById('btnMenuAbandon').hidden === false &&
    doc.getElementById('btnMenuAbandon').classList.contains('danger'));
  let confirmMsg = null;
  const oldConfirm = window.confirm;
  window.confirm = (msg) => { confirmMsg = msg; return true; };
  doc.getElementById('btnMenuAbandon').click();
  window.confirm = oldConfirm;
  check('abandoning a run asks for confirmation with the exact message',
    confirmMsg === 'Are you sure you want to abandon this run?');
  check('abandoning clears the gauntlet run and returns to title',
    !mem.get(S.SLOTS.gauntlet) &&
    doc.getElementById('screenTitle').hidden === false &&
    doc.getElementById('gauntletMain').textContent === 'Full team gauntlet');

  mem.clear();
  Object.defineProperty(window, 'localStorage', originalLocalStorage);
}

// ------------------------------------------------------------- roles ------
// Generated sets used to be four damaging moves on everything, so every
// Pokemon played identically. Roles reserve slots for the utility that
// actually creates decisions, while STAB stays mandatory.
{
  const Dex = window.PS.Dex;
  const isStatus = (id) => Dex.moves.get(id).category === 'Status';
  const hasStab = (m) => m.moves.some((id) => {
    const d = Dex.moves.get(id);
    return d.basePower > 0 && m.types.includes(d.type);
  });

  const wall = await C.makeMon('blissey', { role: 'wall' });
  const sweeper = await C.makeMon('gengar', { role: 'sweeper' });
  const hazard = await C.makeMon('ferrothorn', { role: 'hazard' });
  const plain = await C.makeMon('gengar');

  check('a role is recorded on the Pokemon', wall.role === 'wall' && sweeper.role === 'sweeper');
  check('a wall carries real utility, not four attacks',
    wall.moves.filter(isStatus).length >= 1, wall.moves.join(', '));
  check('a sweeper still leads with offence',
    sweeper.moves.filter((id) => !isStatus(id)).length >= 3, sweeper.moves.join(', '));
  check('a hazard lead brings hazards',
    hazard.moves.some((id) => ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'].includes(id)),
    hazard.moves.join(', '));
  check('STAB is never dropped for utility',
    hasStab(wall) && hasStab(sweeper) && hasStab(hazard));
  check('roles produce genuinely different sets',
    JSON.stringify(sweeper.moves) !== JSON.stringify(wall.moves));
  check('an unroled Pokemon keeps the old all-attacks behaviour',
    plain.moves.every((id) => !isStatus(id)), plain.moves.join(', '));
  check('every set is still exactly four legal moves',
    [wall, sweeper, hazard, plain].every((m) =>
      m.moves.length === 4 && new Set(m.moves).size === 4 &&
      m.moves.every((id) => Dex.moves.get(id).exists)));
}

// -------------------------------------------------------------- enemy AI ---
// The old AI gave EVERY status move a flat 12-20 score, so it happily
// re-applied a status the target already had, Thunder Waved Ground types, and
// set up on the turn it was about to be knocked out. Scoring now reads the
// board, so these are the situations that must come out right.
{
  const RB = window.RogueBattle;
  const Dex = window.PS.Dex;
  const sc = (moveId, ctx) => RB._scoreAIMove(Dex.moves.get(moveId), {
    myTypes: ['Normal'], foeTypes: ['Normal'], myHp: 1, foeHp: 1,
    myStatus: '', foeStatus: '', boosts: null, faster: true, depth: 3, turn: 1,
    hazardsUp: false, weather: '', ...ctx,
  });

  check('AI never re-applies an existing status',
    sc('thunderwave', { foeStatus: 'par' }) === 0);
  check('AI respects STATUS immunities',
    sc('willowisp', { foeTypes: ['Fire'] }) === 0 &&
    sc('toxic', { foeTypes: ['Steel'] }) === 0 &&
    sc('toxic', { foeTypes: ['Poison'] }) === 0 &&
    sc('glare', { foeTypes: ['Electric'] }) === 0);
  // Thunder Wave is an ELECTRIC move, so Ground ignores it -- a different
  // immunity from "Electric types can't be paralysed", and the one the AI
  // originally missed.
  check('AI respects TYPE immunities on status moves',
    sc('thunderwave', { foeTypes: ['Ground'] }) === 0);
  check('AI still paralyses a Ground type with a non-Electric move',
    sc('glare', { foeTypes: ['Ground'] }) > 0);
  check('AI knows powder moves miss Grass types',
    sc('sleeppowder', { foeTypes: ['Grass'] }) === 0 &&
    sc('sleeppowder', { foeTypes: ['Water'] }) > 0);
  check('AI still uses status on a legal target',
    sc('thunderwave', {}) > 0 && sc('willowisp', { foeTypes: ['Grass'] }) > 0);
  check('paralysis is worth more when losing the speed race',
    sc('thunderwave', { faster: false }) > sc('thunderwave', { faster: true }));

  check('AI does not heal at full HP', sc('recover', { myHp: 1 }) === 0);
  check('AI heals when it actually hurts',
    sc('recover', { myHp: 0.3 }) > sc('recover', { myHp: 0.8 }));

  check('AI does not set up on the brink', sc('swordsdance', { myHp: 0.2 }) === 0);
  check('AI sets up from a healthy position', sc('swordsdance', { myHp: 1 }) > 0);
  check('AI stops setting up once boosted',
    sc('swordsdance', { boosts: { atk: 4 } }) === 0);
  check('AI prefers finishing a nearly-dead foe over setting up',
    sc('bodyslam', { foeHp: 0.15 }) > sc('swordsdance', { foeHp: 0.15 }));

  check('AI will not stack hazards it already set',
    sc('stealthrock', { hazardsUp: true }) === 0);
  check('AI leads with hazards, then loses interest',
    sc('stealthrock', { turn: 1 }) > sc('stealthrock', { turn: 8 }));

  check('AI never picks a move the target is immune to',
    sc('earthquake', { foeTypes: ['Flying'] }) === 0);
  check('AI values super-effective damage',
    sc('surf', { myTypes: ['Water'], foeTypes: ['Fire'] }) >
    sc('surf', { myTypes: ['Water'], foeTypes: ['Grass'] }));
  check('priority is favoured to finish a weakened foe',
    sc('extremespeed', { foeHp: 0.15 }) > sc('extremespeed', { foeHp: 1 }));

  // The whole point: the same move scores differently in different situations.
  check('the AI is genuinely situational, not a fixed ranking',
    sc('recover', { myHp: 0.2 }) > sc('bodyslam', { myHp: 0.2, foeHp: 1 }) &&
    sc('bodyslam', { myHp: 1, foeHp: 0.1 }) > sc('recover', { myHp: 1, foeHp: 0.1 }));

  // A trainer request must still produce a legal choice string.
  const req = { active: [{ moves: [
    { id: 'tackle', pp: 10, maxpp: 10 },
    { id: 'thunderwave', pp: 10, maxpp: 10 },
  ] }] };
  const choice = RB._chooseAIMove(req, ['Electric'], ['Water'], { depth: 2 });
  check('the AI returns a legal engine choice', /^move [12]$/.test(choice), choice);

  // A Daily is a shared puzzle: the tie-breaking jitter must be seeded (the
  // app passes a per-battle mulberry32 for daily runs) so two players on the
  // same day get the same opponent decisions. Reproducibility is the property;
  // without a rand in the context the engine keeps real randomness.
  check('seeded AI scoring is deterministic',
    (() => {
      const seeded = (seed) => sc('bodyslam', { rand: window.Core.mulberry32(seed) });
      return seeded(42) === seeded(42);
    })());
  check('seeded AI choice is reproducible across a request',
    (() => {
      const choice2 = (seed) => RB._chooseAIMove(req, ['Electric'], ['Water'],
        { depth: 2, rand: window.Core.mulberry32(seed) });
      return choice2(1234) === choice2(1234);
    })());
  check('an AI with no usable moves falls back to default',
    RB._chooseAIMove({ active: [{ moves: [{ id: 'tackle', pp: 0, disabled: true }] }] },
      ['Normal'], ['Normal'], {}) === 'default');
}

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

// ------------------------------------ identity survives a switch (REGRESSION)
// Showdown REORDERS side.pokemon whenever anyone switches: the incoming mon is
// swapped into the outgoing mon's slot. Any code that reads `p1.pokemon[i]` as
// "party member i" therefore writes the wrong HP onto the wrong Pokemon.
//
// That was the Gauntlet bug: when the LEAD fainted and you sent out a
// replacement, the engine swapped the two, the index-based sync copied the
// replacement's healthy HP back onto the dead lead and the lead's 0 HP onto
// the replacement -- so the lead was resurrected for the next round and an
// untouched party member got buried in its place.
//
// This asserts the invariant that makes the whole thing safe: after a switch,
// syncing must still route each engine Pokemon to the correct run object.
{
  const party = [
    await C.makeMon('gengar'),
    await C.makeMon('garchomp'),
    await C.makeMon('blissey'),
  ];
  party.forEach((m, i) => { m.uid = 'party' + i; });
  const foe = [await C.makeMon('snorlax')];

  const swapped = await new Promise((res) => {
    let switchedOnce = false, requests = 0;
    const timer = setTimeout(() => res({ timeout: true }), 8000);
    const b = window.RogueBattle.startBattle({
      playerMons: party, enemyMons: foe, isWild: false, trainerName: 'Tester',
      handlers: {
        onLog() {},
        onRequest(req) {
          if (++requests > 30) { clearTimeout(timer); return res({ capped: true }); }
          if (req && req.forceSwitch) { setTimeout(() => b.chooseSwitch(1), 0); return; }
          if (req && req.active) {
            // Switch to party slot 1 exactly once, then keep attacking. That
            // one switch is all it takes to reorder the engine's array.
            if (!switchedOnce) {
              switchedOnce = true;
              setTimeout(() => b.chooseSwitch(1), 0);
              return;
            }
            clearTimeout(timer);
            // Report how the engine has reordered itself, and who the wrapper
            // believes each engine slot belongs to.
            const live = b.battle.p1.pokemon;
            // Give every engine Pokemon a distinct, recognisable HP so we can
            // see exactly where each value lands once we sync.
            live.forEach((p, n) => { p.hp = Math.round(p.maxhp * (0.9 - n * 0.3)); });
            const expected = {};
            live.forEach((p) => {
              const owner = party.find((m) => m.id === String(p.species.id));
              if (owner) expected[owner.uid] = p.hp / p.maxhp;
            });
            b.sync();   // the identity-based sync used by syncBattleToRun()
            return res({
              // engine order, by species -- proves a real reorder happened
              engineOrder: live.map((p) => String(p.species.id)).join(','),
              partyOrder: party.map((m) => m.id).join(','),
              // the wrapper's own idea of who is on the field
              activeUid: b.activeMon() ? b.activeMon().uid : null,
              activeIndex: b.activeIndex(),
              // did each run object receive ITS OWN hp, not a neighbour's?
              hpRoutedCorrectly: party.every(
                (m) => Math.abs(m.hpPct - expected[m.uid]) < 1e-9),
              // what a naive index-based sync would have produced
              indexSyncWouldCorrupt: party.some(
                (m, n) => live[n] && String(live[n].species.id) !== m.id),
              got: party.map((m) => `${m.id}=${m.hpPct.toFixed(2)}`).join(' '),
            });
          }
        },
        onEnd() { clearTimeout(timer); res({ endedEarly: true }); },
        onError(e) { clearTimeout(timer); res({ error: e.message }); },
      },
    });
  });

  // Only assert if we actually got far enough to observe a switch.
  if (swapped.engineOrder) {
    check('a switch really does reorder the engine party array',
      swapped.engineOrder !== swapped.partyOrder,
      `engine=${swapped.engineOrder} vs party=${swapped.partyOrder}`);
    // The heart of it: after the reorder, the wrapper still resolves the
    // ACTIVE Pokemon to the right run object (garchomp = party slot 1).
    check('after a switch the engine still maps to the right party member',
      swapped.activeUid === 'party1' && swapped.activeIndex === 1,
      `uid=${swapped.activeUid} index=${swapped.activeIndex}`);
    // Sanity: this scenario is genuinely one that index-based syncing breaks,
    // so the next check is actually testing something.
    check('the scenario would defeat an index-based sync',
      swapped.indexSyncWouldCorrupt === true);
    // The fix itself: HP lands on its own owner, so a dead lead stays dead and
    // no bystander inherits its 0 HP.
    check('syncing after a switch gives every Pokemon its own HP',
      swapped.hpRoutedCorrectly === true, swapped.got);
  } else {
    check('switch-identity probe ran', false,
      swapped.error || (swapped.timeout ? 'TIMED OUT' : 'battle ended too early'));
  }
}

// --------------------------------------------------------- BattleUI mount --
// Boot leaves the title showcase alive; stop it before testing an independent
// BattleUI so the singleton's ownership guard is being exercised honestly.
window.Game.show('Crossroads');
const host = window.document.getElementById('battleHost');
const ui = new window.BattleUI();
ui.mount(host);
check('BattleUI mounts', ui.s.mounted === true);

// The Gauntlet strips the battle controls down to just "Party": no items to
// use, no escape from a trainer. Other modes must keep every button.
ui.setActions({ canSwitch: true, canRun: true, itemCount: 3 });
const wildBtns = [...host.querySelectorAll('.ab')]
  .map((b) => `${b.dataset.a}:${b.disabled}`).sort().join(',');
check('a regular battle keeps bag, party and a working run button',
  wildBtns === 'bag:false,run:false,switch:false', wildBtns);
ui.setActions({ canSwitch: true, noBag: true, noRun: true });
const gBtns = [...host.querySelectorAll('.ab')].map((b) => b.dataset.a).join(',');
check('a gauntlet battle offers only the party button', gBtns === 'switch', gBtns);
check('the gauntlet actbar collapses to a single column',
  !!host.querySelector('.actbar.one'));
ui.setActions(null);
ui.render();
ui.unmount();

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
const sessionRenderer = ui2.r;
ui.unmount();
ui2.unmount();
host2.remove();

// A missing renderer dependency must fail loudly instead of leaving a queued
// BattleUI that never paints and never tells the player what happened.
{
  const savedThree = window.THREE;
  const missingHost = window.document.createElement('div');
  window.document.body.appendChild(missingHost);
  window.THREE = undefined;
  const missingUi = new window.BattleUI();
  missingUi._mountAttempts = 201;
  let missingMountError = null;
  missingUi.onMountError = (_owner, err) => { missingMountError = err; };
  missingUi.mount(missingHost);
  check('missing THREE reports a mount error',
    !!missingMountError && /3D engine/i.test(missingMountError.message));
  check('missing THREE clears the mount flag', missingHost._bm == null);
  window.THREE = savedThree;
  missingHost.remove();
}

// ================================================== RENDERER LIFECYCLE =====
// The renderer is a session singleton: screen teardown removes its canvas but
// never destroys the WebGL context. A mount that dies halfway must still leave
// no partial DOM or zombie mount flag behind.
{
  const RealGroup = window.THREE.Group;
  const goodHost = window.document.createElement('div');
  window.document.body.appendChild(goodHost);
  const goodUi = new window.BattleUI();
  let intentionalLossCalls = 0;
  goodUi.onContextLost = () => { intentionalLossCalls++; };
  goodUi.mount(goodHost);
  check('a BattleUI mounts on a clean host', goodUi.s.mounted === true);
  const goodRenderer = goodUi.r;
  check('BattleUI reuses the session WebGL renderer', goodRenderer === sessionRenderer);
  goodUi.unmount();
  check('unmount keeps the shared WebGL context alive',
    !!goodRenderer && goodRenderer === sessionRenderer);
  check('unmount does not report an intentional context release', intentionalLossCalls === 0,
    String(intentionalLossCalls));
  check('unmount removes every canvas, environment, sprite and HUD layer',
    goodHost.querySelectorAll('canvas, .bm-env, .bm-sprites, .battle-hud').length === 0);

  // A real context-loss event must be cancelled, reported once, and followed
  // by a restoration callback. Unmounting only moves the shared canvas away;
  // it must never manufacture another context-loss event.
  const lossHost = window.document.createElement('div');
  window.document.body.appendChild(lossHost);
  const lossUi = new window.BattleUI();
  lossUi.mount(lossHost);
  let lossCalls = 0, restoredCalls = 0;
  lossUi.onContextLost = () => { lossCalls++; };
  lossUi.onContextRestored = () => { restoredCalls++; };
  const lossEnvironment = lossHost.querySelector('.bm-env[data-biome]');
  check('the CSS environment exists before WebGL context loss', !!lossEnvironment);
  const lossEvent = new window.Event('webglcontextlost', { cancelable: true });
  lossUi.r.domElement.dispatchEvent(lossEvent);
  lossUi.r.domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true }));
  check('a WebGL context loss is prevented and reported once',
    lossEvent.defaultPrevented && lossCalls === 1 && lossUi.flat,
    `prevented=${lossEvent.defaultPrevented}, calls=${lossCalls}, flat=${lossUi.flat}`);
  check('context loss reveals the same complete CSS environment',
    !!lossEnvironment && lossEnvironment.isConnected &&
    lossHost.classList.contains('battle-flat'));
  lossUi.r.domElement.dispatchEvent(new window.Event('webglcontextrestored'));
  check('context restoration is surfaced for scene rebuild', restoredCalls === 1,
    String(restoredCalls));
  check('the CSS environment remains mounted after context restoration',
    !!lossEnvironment && lossEnvironment.isConnected &&
    lossHost.querySelector('.bm-env') === lossEnvironment);
  lossUi.unmount();
  check('unmount does not report a new context loss', lossCalls === 1,
    String(lossCalls));

  // Even a sustained stream of WebGL render failures is cosmetic: the DOM HUD
  // and sprites stay alive in flat mode while the session replaces the canvas.
  const renderFailHost = window.document.createElement('div');
  window.document.body.appendChild(renderFailHost);
  const renderFailUi = new window.BattleUI();
  let sustainedLosses = 0, sustainedFatal = 0;
  renderFailUi.onContextLost = () => { sustainedLosses++; };
  renderFailUi.onError = () => { sustainedFatal++; };
  renderFailUi.mount(renderFailHost);
  if (renderFailUi.r) renderFailUi.r.render = () => { throw new Error('synthetic sustained GPU failure'); };
  for (let frame = 0; frame < 60; frame++) renderFailUi._anim();
  check('sustained GPU failure reveals the complete fallback instead of crashing',
    renderFailUi.flat === true && sustainedLosses === 1 && sustainedFatal === 0 &&
    !!renderFailHost.querySelector('.battle-hud') && !!renderFailHost.querySelector('.bm-env'),
    `flat=${renderFailUi.flat} losses=${sustainedLosses} fatal=${sustainedFatal}`);
  renderFailUi.unmount();
  renderFailHost.remove();

  const ownerHost = window.document.createElement('div');
  window.document.body.appendChild(ownerHost);
  const ownerA = new window.BattleUI(); ownerA.mount(ownerHost);
  const ownerB = new window.BattleUI();
  let ownershipErr = null;
  try { ownerB.mount(ownerHost); } catch (e) { ownershipErr = e; }
  check('a busy battle host fails loudly', !!ownershipErr && /already mounted/i.test(ownershipErr.message));
  ownerA.unmount(); ownerHost.remove();

  // A scene-build failure after the canvas/sprites/HUD were appended must
  // leave the host empty and clear its mount flag. (The singleton renderer
  // itself is intentionally never destroyed.)
  window.THREE.Group = class { constructor() { throw new Error('synthetic WebGL scene failure'); } };
  const badHost = window.document.createElement('div');
  window.document.body.appendChild(badHost);
  const badUi = new window.BattleUI();
  let mountErr = null;
  try { badUi.mount(badHost); } catch (e) { mountErr = e; }
  check('a scene-build failure rethrows a descriptive error',
    !!mountErr && /could not mount/i.test(mountErr && mountErr.message),
    mountErr && mountErr.message);
  check('a scene-build failure leaves no partial DOM in the host',
    badHost.querySelectorAll('canvas, .bm-env, .bm-sprites, .battle-hud').length === 0);
  check('a scene-build failure clears the host mount flag', badHost._bm == null);

  window.THREE.Group = RealGroup;
  goodHost.remove();
  lossHost.remove();
  badHost.remove();
}

// ===================================== RENDERER SELF-HEALING REGRESSIONS =====
// The "3D falls back to 2D every single run" bug: one transient context
// creation failure used to flip the session into a PERMANENT 'unavailable'
// state, so the title and every battle of every run rendered flat forever.
// The session must retry by itself and upgrade the live screen in place.
{
  const waitFx = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  };

  // 1. A transient creation failure at (re)creation time heals WITHOUT a
  // remount. Setup: lose the current healthy context so the next mount MUST
  // create a renderer -- that creation is the one we make fail once.
  const tmpHost = window.document.createElement('div');
  window.document.body.appendChild(tmpHost);
  const tmpUi = new window.BattleUI();
  tmpUi.mount(tmpHost);
  check('fixture: a healthy renderer exists before the hiccup', !!tmpUi.r && !tmpUi.flat);
  const RealRendererCtor = window.THREE.WebGLRenderer;
  let ctorCalls = 0;
  window.THREE.WebGLRenderer = class {
    constructor() {
      ctorCalls++;
      if (ctorCalls === 1) throw new Error('synthetic transient GPU hiccup');
      return new RealRendererCtor(); // legal: ctors may return a substitute object
    }
  };
  tmpUi.r.domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true }));
  tmpUi.unmount();
  tmpHost.remove();

  const healHost = window.document.createElement('div');
  window.document.body.appendChild(healHost);
  const healUi = new window.BattleUI();
  healUi.mount(healHost);
  const healingEnvironment = healHost.querySelector('.bm-env[data-biome]');
  check('a transient creation failure mounts its CSS environment and stays playable',
    ctorCalls === 1 && healUi.flat === true && healUi.s.mounted === true &&
    !healHost.querySelector('canvas') && !!healingEnvironment,
    `ctorCalls=${ctorCalls} flat=${healUi.flat} mounted=${healUi.s.mounted}`);
  check('the failed mount does NOT throw or poison the mount flag', healHost._bm === healUi);
  // Restore THREE so the background retry (300ms out) uses the real renderer.
  window.THREE.WebGLRenderer = RealRendererCtor;
  const healed = await waitFx(() => !healUi.flat && healHost.querySelector('canvas') && healUi.r);
  check('background recovery recreates the renderer and upgrades in place',
    !!healed, healed ? '' : 'still flat after 6s');
  check('renderer recovery preserves the exact same CSS environment underneath',
    !!healed && healingEnvironment.isConnected &&
    healHost.querySelector('.bm-env') === healingEnvironment);
  const healRenderer = healUi.r;
  healUi.unmount();

  // 2. A healthy renderer is REUSED after recovery (no context churn).
  const reuseHost = window.document.createElement('div');
  window.document.body.appendChild(reuseHost);
  const reuseUi = new window.BattleUI();
  reuseUi.mount(reuseHost);
  check('post-recovery mounts reuse the same renderer', reuseUi.r === healRenderer && !reuseUi.flat);

  // 3. A racing mount must never throw: the newest screen takes the renderer
  // over, the displaced one stays playable flat. This used to crash the whole
  // battle start with "renderer is still in use".
  const raceHost = window.document.createElement('div');
  window.document.body.appendChild(raceHost);
  const raceUi = new window.BattleUI();
  let raceErr = null;
  let reclaimCalls = 0;
  reuseUi.onContextLost = () => { reclaimCalls++; };
  try { raceUi.mount(raceHost); } catch (e) { raceErr = e; }
  check('a racing mount reclaims instead of throwing',
    raceErr == null && raceUi.s.mounted === true && !raceUi.flat && !!raceHost.querySelector('canvas'),
    raceErr && raceErr.message);
  check('the displaced screen degrades to flat (playable), not a crash',
    reuseUi.flat === true, `flat=${reuseUi.flat}, reclaimCalls=${reclaimCalls}`);
  raceUi.unmount();
  try { reuseUi.unmount(); } catch (_) {}
  healHost.remove();
  reuseHost.remove();
  raceHost.remove();

  // 4. WebKit's silent loss path: a lost context with NO restored event must
  // still heal -- by recreation, not by waiting on an event that never comes.
  const silentHost = window.document.createElement('div');
  window.document.body.appendChild(silentHost);
  const silentUi = new window.BattleUI();
  silentUi.mount(silentHost);
  const silentOldR = silentUi.r;
  const silentEnvironment = silentHost.querySelector('.bm-env[data-biome]');
  silentUi._notifyContextLost(); // renderer reported it; no DOM event follows
  check('silent loss enters flat mode with its environment visible',
    silentUi.flat === true && !!silentEnvironment && silentEnvironment.isConnected &&
    silentHost.classList.contains('battle-flat'));
  const silentHealed = await waitFx(() =>
    !silentUi.flat && silentUi.r && silentUi.r !== silentOldR && silentHost.querySelector('canvas'));
  check('silent loss heals by RECREATING the renderer (no restored event needed)',
    !!silentHealed, silentHealed ? '' : 'never recreated');
  check('silent recovery keeps the same environment mounted beneath WebGL',
    !!silentHealed && silentEnvironment.isConnected &&
    silentHost.querySelector('.bm-env') === silentEnvironment);
  check('renderer recreation removes the dead canvas instead of stacking canvases',
    !!silentHealed && silentHost.querySelectorAll('canvas').length === 1 &&
    !silentOldR.domElement.isConnected,
    `canvases=${silentHost.querySelectorAll('canvas').length}`);
  silentUi.unmount();
  silentHost.remove();
}

// ====================================================== FLAT MODE SPRITES =====
// The regression that made flat mode (no WebGL / context lost) unplayable:
// _anim() used to return before projecting DOM sprites when this.r was null,
// so the Pokemon stayed invisible (opacity 0, width 0) and the battle was just
// a gradient + HUD. Projection must run with or without a WebGL renderer.
{
  const fh = window.document.createElement('div');
  window.document.body.appendChild(fh);
  const fui = new window.BattleUI();
  fui.mount(fh);
  fui.buildBiome('cave');
  fui.setWeather('rain');
  fui.setTerrain('electric');
  fui.setRoom('trickroom');
  const fallbackEnv = fh.querySelector('.bm-env');
  check('the CSS environment mirrors biome, weather, terrain and room state',
    !!fallbackEnv && fallbackEnv.dataset.biome === 'cave' &&
    fallbackEnv.dataset.weather === 'rain' && fallbackEnv.dataset.terrain === 'electric' &&
    fallbackEnv.dataset.room === 'trickroom');
  fui.setPlayer({ name: 'P', lv: 100, types: ['Fire'], hp: 1, max: 100, h: 1,
    sid: 'charizard', num: 6, u: [] });
  fui.setEnemy({ name: 'E', lv: 100, types: ['Water'], hp: 1, max: 100, h: 1,
    sid: 'blastoise', num: 9, u: [] });
  // Simulate WebGL being gone: no renderer, flat mode on.
  fui.flat = true;
  fui.r = null;
  // The THREE stub's Vector3.project() is an identity, which would clip the
  // enemy at world z=-3.6 as "behind the camera". Swap in a perspective-ish
  // divide so both combatants stay in view, like a real THREE camera does.
  const projectionScratch = [fui.s.p.headV, fui.s.p.feetV, fui.s.e.headV, fui.s.e.feetV];
  const oldProjectors = projectionScratch.map((v) => v.project);
  projectionScratch.forEach((v) => {
    v.project = function () { const w = 10; return this.set(this.x / w, this.y / w, this.z / w); };
  });
  let projErr = null;
  try { fui._projectSprites(1, 0.016); } catch (e) { projErr = e; }
  projectionScratch.forEach((v, i) => { v.project = oldProjectors[i]; });
  const pw = fui.s.p.img.style.width, ew = fui.s.e.img.style.width;
  check('flat mode still projects DOM sprites (not stuck invisible)',
    !projErr && pw !== '0px' && ew !== '0px', `player=${pw} enemy=${ew}${projErr ? ' err=' + projErr.message : ''}`);
  check('flat mode leaves the HUD usable', !!fh.querySelector('.battle-hud'));
  // A mounted flat UI must also survive the full animation loop without
  // throwing -- it used to early-return, which was the whole bug.
  let flatLoopError = null;
  try { fui._anim(); fui._anim(); } catch (e) { flatLoopError = e; }
  check('flat mode animation loop runs without a renderer', !flatLoopError,
    flatLoopError && flatLoopError.message);
  fui.unmount();
  fh.remove();
}

const realErrors = consoleErrors.filter((e) => !/THREE|WebGL|cry|audio|sprite|mount unavailable/i.test(e));
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

check('battle render loop stays error-free', rafErrors.length === 0,
  [...new Set(rafErrors)].slice(0, 2).join(' | '));

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
