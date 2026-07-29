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
check('window.Daily (daily challenge)', !!window.Daily);
check('window.Modal (shared dialog controller)', !!window.Modal);

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
  const whiteButtonRule = (appCss.match(/\.btn-white\s*\{([^}]*)\}/) || [])[1] || '';
  const dailyButtonRule = (appCss.match(/\.btn-daily\s*\{([^}]*)\}/) || [])[1] || '';
  check('start-screen CTAs are plain white and black with no outline ring',
    /background:#fff/.test(whiteButtonRule) && /color:#000/.test(whiteButtonRule) &&
    !/outline|0\s+0\s+0/.test(whiteButtonRule + dailyButtonRule));
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
    swSrc.includes('src/daily.js') && swSrc.includes('src/modal.js'));

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
  // storage implementation (tools/e2e/run.mjs covers the real thing).
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
// One controller, WAI dialog pattern. Focus behaviour needs a real browser
// (see tools/e2e/run.mjs); these cover the parts JSDOM can see.
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

  const siblingsInert = (() => {
    let n = menu, ok = true;
    while (n && n !== doc.body && n.parentElement) {
      for (const sib of n.parentElement.children) {
        if (sib === n || sib.tagName === 'SCRIPT' || sib.tagName === 'TEMPLATE') continue;
        if (sib.inert !== true && sib.getAttribute('aria-hidden') !== 'true') ok = false;
      }
      n = n.parentElement;
    }
    return ok;
  })();
  check('everything behind the dialog is inert', siblingsInert);

  check('the controller tracks what is open', M.isOpen('screenMenu') && M.depth === 1);

  // Nesting: the picker can open above the menu.
  M.open('screenPicker');
  check('modals stack', M.depth === 2 && M.isOpen('screenPicker'));
  M.close('screenPicker');
  check('closing the top restores the one below',
    M.depth === 1 && M.isOpen('screenMenu') &&
    doc.getElementById('screenPicker').hidden === true);

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
      !!stripSprite && /max-height:\s*46px/.test(stripSprite.getAttribute('style') || ''),
      stripSprite && stripSprite.getAttribute('style'));

    window.document.querySelector('#xTeam .tslot[data-i="0"]').click();
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
