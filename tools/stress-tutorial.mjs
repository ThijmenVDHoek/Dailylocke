// ============================================================================
// stress-tutorial.mjs — drives a REAL guided run (fresh game -> full tutorial
// -> several more battles) in JSDOM with the same THREE surface the smoke
// test stubs, while instrumenting the exact lifecycle counters a real-browser
// GPU crash would disturb first:
//
//   * WebGLRenderer constructions       (a shared-context design must stay at 1)
//   * canvas elements in the document  (zombie canvases = leaked GL contexts)
//   * pending setTimeout/setInterval   (an armed-timer leak parks the GPU loop)
//   * pending requestAnimationFrame    (orphaned render loops keep burning GPU)
//   * battle-host residue after teardown (env / sprites / HUD nodes)
//   * renderer identity across battles  (one session renderer, one canvas)
//   * page errors
//
// Run:  node tools/stress-tutorial.mjs
// ============================================================================
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const html = readFileSync(resolve(repo, 'index.html'), 'utf8');
const scriptSrcs = [...html.matchAll(/<script\s+defer\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (err) => {
  if (/navigation/.test((err && err.message) || '')) return;
  pageErrors.push(String((err && err.message) || err));
});
const dom = new JSDOM(html, {
  url: pathToFileURL(resolve(repo, 'index.html')).href,
  pretendToBeVisual: true,
  runScripts: 'outside-only',
  virtualConsole: vc,
});
const { window } = dom;

// Layout shims (same as smoke-test.mjs)
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { get() { return 800; }, configurable: true },
  clientHeight: { get() { return 600; }, configurable: true },
  offsetParent: { get() { return this.parentNode; }, configurable: true },
});
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
};
window.HTMLElement.prototype.getClientRects = function () { return [{ width: 800, height: 600 }]; };
window.scrollTo = () => {};
window.__thrown = [];
const _onErr = (msg) => window.__thrown.push(String(msg));
window.addEventListener('error', _onErr);

// Web Animations stub (the ball-throw FX drives itself with setTimeout)
window.Element.prototype.animate = function () {
  return { cancel() {}, play() {}, pause() {}, finish() {}, onfinish: null, oncancel: null, finished: Promise.resolve(), ready: Promise.resolve() };
};

// ---- timer / rAF bookkeeping -------------------------------------------------
const timers = new Set();
const rafs = new Set();
{
  const ost = window.setTimeout.bind(window);
  const osi = window.setInterval.bind(window);
  const oct = window.clearTimeout.bind(window);
  const oci = window.clearInterval.bind(window);
  window.setTimeout = function (fn, ms, ...a) {
    const h = ost(function () { timers.delete(h); return fn.apply(this, arguments); }, ms, ...a);
    timers.add(h);
    return h;
  };
  window.setInterval = function (fn, ms, ...a) {
    const h = osi(function () { return fn.apply(this, arguments); }, ms, ...a);
    timers.add(h);
    return h;
  };
  window.clearTimeout = function (h) { timers.delete(h); return oct(h); };
  window.clearInterval = function (h) { timers.delete(h); return oci(h); };
  const oraf = window.requestAnimationFrame.bind(window);
  const ocaf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    const h = oraf(function (t) { rafs.delete(h); return cb(t); });
    rafs.add(h);
    return h;
  };
  window.cancelAnimationFrame = function (h) { rafs.delete(h); return ocaf(h); };
}

// ---- network shims ------------------------------------------------------------
window.Image = class {
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
  set src(_v) {} get src() { return ''; } addEventListener() {} removeEventListener() {}
};
window.Audio = class {
  constructor() { this.volume = 1; this.preload = ''; this.paused = true; this._src = ''; }
  set src(v) { this._src = v; } get src() { return this._src; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {} addEventListener() {} removeEventListener() {}
};

// ---- THREE surface stub (as in smoke-test.mjs), plus a creation counter ------
window.__webglCreations = 0;
window.__webglRenderCalls = 0;
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
    constructor() { window.__webglCreations++; this.domElement = window.document.createElement('canvas');
      this.shadowMap = {}; this.__seq = window.__webglCreations; }
    setPixelRatio() {} setSize() {}
    render() { window.__webglRenderCalls++; }
    dispose() {}
  },
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

// ---- lazy learnsets interception (same as smoke-test.mjs) --------------------
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

// ---- localStorage shim (in-memory, like the smoke test) ----------------------
const mem = new Map();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  },
});

// ---- evaluate modules ---------------------------------------------------------
for (const src of ['vendor/battle-ui.js', 'src/ui-patch.js']) {
  window.eval(readFileSync(resolve(repo, src), 'utf8'));
}
for (const src of scriptSrcs) {
  if (src.includes('renderer-loader.js') || src.includes('app-loader.js')) continue;
  window.eval(readFileSync(resolve(repo, src), 'utf8'));
}

window.__eng = [];
{
  const _rb = window.RogueBattle;
  const _start = _rb.startBattle;
  _rb.startBattle = function (cfg) {
    const h = cfg.handlers || {};
    cfg.handlers = Object.assign({}, h);
    const log = h.onLog, req = h.onRequest, end = h.onEnd;
    cfg.handlers.onLog = function (chunk) {
      window.__eng.push('LOG>> ' + String(chunk).split('\n').filter(l => l && l[0] === '|')
        .map(l => l.split('|').slice(1, 3).join('|')).join(' / '));
      if (log) log(chunk);
    };
    cfg.handlers.onRequest = function (r) {
      window.__eng.push('REQ>> wait=' + !!r.wait + ' forceSwitch=' + !!r.forceSwitch +
        ' active=' + !!(r.active && r.active[0]));
      if (req) req(r);
    };
    cfg.handlers.onEnd = function (res) { window.__eng.push('END>> ' + res.result); if (end) end(res); };
    return _start.call(this, cfg);
  };
}
// trace UI state calls
{
  const BU = window.BattleUI;
  const oSM = BU.prototype.setMoves;
  BU.prototype.setMoves = function (mv, mg, cb) {
    window.__eng.push('UI setMoves ' + JSON.stringify((mv || []).map((m) => m.id + (m.disabled ? ':D' : ':E'))));
    return oSM.call(this, mv, mg, cb);
  };
}

window.eval(readFileSync(resolve(repo, 'src/app.js'), 'utf8'));

const doc = window.document;
const $ = (id) => doc.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await wait(50);
  }
  return null;
};

// ---------------------------------------------------------------- snapshot ---
function snapshot(label) {
  const ui = window.Game.ui || null;
  return {
    label,
    webglCreations: window.__webglCreations,
    renderCalls: window.__webglRenderCalls,
    canvases: doc.querySelectorAll('canvas').length,
    timers: timers.size,
    rafs: rafs.size,
    battleHostChildren: doc.querySelectorAll('#battleHost > *').length,
    battleEnvs: doc.querySelectorAll('#battleHost .bm-env').length,
    battleHuds: doc.querySelectorAll('#battleHost .battle-hud').length,
    battleSprites: doc.querySelectorAll('#battleHost .bm-sprites').length,
    bubbles: doc.querySelectorAll('.coach-bubble').length,
    spots: doc.querySelectorAll('.coach-spot').length,
    uiFlat: !!(ui && ui.flat),
    uiCanvasSeq: (ui && ui.r && ui.r.domElement && ui.r.domElement.__seq) || null,
    uiCanvasInDom: !!(ui && ui.r && ui.r.domElement && ui.r.domElement.isConnected),
    errors: pageErrors.length,
  };
}

const LOG = [];
function log(label) { LOG.push(snapshot(label)); }

// ---------------------------------------------------------------- auto-play ---
let battleCount = 0;
let lastBattleInSection = -1;
let mvCursor = 0;

async function autoPlay(maxMs) {
  const t0 = Date.now();
  let lastBeat = 0;
  while (Date.now() - t0 < maxMs) {
    if (Date.now() - lastBeat > 5000) {
      lastBeat = Date.now();
      console.log('  [beat]', JSON.stringify({
        won: window.Game.run.battlesWon,
        sec: window.Game.run.section, b: window.Game.run.battleInSection,
        screens: ['Battle', 'Catch', 'Reward', 'Summary', 'Crossroads', 'GameOver']
          .filter((s) => !doc.getElementById('screen' + s).hidden).join('+'),
        coach: window.Modal.isOpen('screenCoach') ? 'sheet' : '',
        bubble: doc.querySelector('.coach-bubble:not([hidden])') ? 'bubble' : '',
        locked: window.Coach.actionLocked(),
        mv: doc.querySelectorAll('#battleHost .mb[data-i]').length,
        mvEnabled: doc.querySelectorAll('#battleHost .mb[data-i]:not([disabled])').length,
        rail: doc.querySelectorAll('#battleHost .br-btn').length,
        tslots: doc.querySelectorAll('#battleHost .tslot').length,
        msg: (window.Game.ui && window.Game.ui.s && window.Game.ui.s.msg || '').slice(0, 60),
        lockUI: !!(window.Game.ui && window.Game.ui.s && window.Game.ui.s.locked),
        inBattle: !!(window.Game.run && window.Game.run._inBattle),
      }));
    }
    const run = window.Game.run;
    if (!run || run.over) return false;

    // 1. coach sheet (modal) — always dismissible
    const sheet = $('screenCoach');
    if (sheet && !sheet.hidden) {
      const ok = sheet.querySelector('[data-coach-ok]');
      if (ok) { ok.click(); await wait(120); continue; }
    }
    // 2. coach bubble
    const bub = doc.querySelector('.coach-bubble:not([hidden])');
    if (bub) {
      const ok = bub.querySelector('[data-coach-ok]');
      if (ok) { ok.click(); await wait(120); continue; }
    }
    // 3. action lock: press the taught thing (prefer real controls: the
    // coach also classes a container (ball rail) that has no handler)
    if (window.Coach && window.Coach.actionLocked()) {
      const spots = [...doc.querySelectorAll('.coach-spot')];
      const spot = spots.find((s) => /BUTTON/.test(s.tagName) && !s.disabled) ||
        spots.find((s) => !s.disabled);
      if (spot) { spot.click(); await wait(150); continue; }
      // lock armed but the taught control is gone — clear it to keep moving
      window.Coach.clearActionLock();
      continue;
    }

    // 4. battle screen
    if (!$('screenBattle').hidden) {
      if (run.section === 1 && run.battleInSection !== lastBattleInSection) {
        lastBattleInSection = run.battleInSection;
        battleCount++;
        log('battle-start s' + run.section + 'b' + run.battleInSection);
      }
      const host = $('battleHost');
      const slot = [...host.querySelectorAll('.tslot:not([disabled]),.pitem:not([disabled])')][0];
      const rail = [...host.querySelectorAll('.br-btn:not([disabled])')][0];
      const mvs = [...host.querySelectorAll('.mb[data-i]:not([disabled])')];
      const mv = mvs[mvCursor % Math.max(1, mvs.length)];
      mvCursor++;
      if (rail) rail.click();
      else if (slot) slot.click();
      else if (mv) mv.click();
      await wait(180);
      continue;
    }
    // 5. catch screen
    if (!$('screenCatch').hidden) {
      if (!$('screenNickname').hidden) {
        const inp = $('nickInput');
        if (inp) inp.value = 'Bud' + (battleCount % 97);
        const ok = $('btnNickOk');
        if (ok) { ok.click(); await wait(120); continue; }
      }
      const done = $('btnCatchDone');
      if (done && !done.hidden) { done.click(); await wait(200); continue; }
    }
    // 6. reward screen
    if (!$('screenReward').hidden) {
      const btn = $('btnRewardDone');
      if (btn) { btn.click(); await wait(250); continue; }
    }
    // 7. section summary
    if (!$('screenSummary').hidden) {
      const go = $('btnSumNext');
      if (go) { go.click(); await wait(400); continue; }
    }
    // 8. crossroads
    if (!$('screenCrossroads').hidden) {
      // tutorial heal step: open the caught partner's card when the run asks
      if (run.prologue && run.section === 1 && !run.tutorialHealDone &&
          run.tutorialCatchDone) {
        const slot = doc.querySelector('#xTeam .tslot[data-i="1"]');
        const detail = $('xTeamDetail');
        if (slot && (!detail || detail.hidden)) { slot.click(); await wait(300); continue; }
      }
      const potion = doc.querySelector('#xTeamDetail .pd-potion-btn');
      if (potion && !$('xTeamDetail').hidden) { potion.click(); await wait(300); continue; }
      const go = $('btnGoBattle');
      if (go && !go.disabled) { go.click(); await wait(450); continue; }
    }
    // 9. game over?
    if (!$('screenGameOver').hidden) return false;
    await wait(200);
  }
  return true; // timed out
}

// ---------------------------------------------------------------- the run -----
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}

console.log('== boot ==');
await new Promise((r) => setTimeout(r, 30));
log('boot');
check('app booted', !!window.Game && !!window.Coach && !!window.BattleUI);
check('title mounted one 3D scene', doc.querySelectorAll('#titleStage canvas').length === 1);

// ---- fresh guided run: title -> setup -> starter -> nickname -> route ----
console.log('== fresh guided run ==');
doc.getElementById('btnFreshGame').click();
await until(() => !$('screenSetup').hidden, 8000);
await until(() => !$('screenCoach').hidden, 8000);
const wok = await until(() => doc.querySelector('#screenCoach [data-coach-ok]'), 6000);
if (wok) wok.click();
$('setupName').value = 'Stress';
$('btnSetupGo').click();
await until(() => doc.querySelectorAll('#starterGrid .starter-card').length === 3, 40000);
await until(() => !$('screenCoach').hidden, 10000);
const sok = await until(() => doc.querySelector('#screenCoach [data-coach-ok]'), 6000);
if (sok) sok.click();
const pick = await until(() => doc.querySelectorAll('#starterGrid .pick-btn')[1], 8000);
pick.click();
await until(() => !$('screenNickname').hidden, 8000);
$('nickInput').value = 'Cinder';
$('btnNickOk').click();
const route = await until(() => !$('screenCrossroads').hidden, 20000);
check('reached the route with a guided run', !!route &&
  window.Game.run.prologue === true, window.Game.run && String(window.Game.run.prologue));
await wait(600);
doc.querySelectorAll('#screenCoach [data-coach-ok]').forEach((b) => b.click());
window.Modal.closeAll();
await wait(600);

// ---- play: full section 1 tutorial + several more battles --------------------
console.log('== playing battles ==');
const PLAY_MS = 600 * 1000; // hard cap for the whole auto-play phase
const t0 = Date.now();
let battles = 0;
while (Date.now() - t0 < PLAY_MS && battles < 14) {
  const before = window.Game.run.battlesWon;
  const timedOut = await autoPlay(25000);
  battles = window.Game.run.battlesWon;
  log('after-battle-' + battles);
  if (timedOut && window.Game.run.battlesWon === before) {
    console.log('  stalled at', window.Game.run.section, window.Game.run.battleInSection,
      'won', battles);
    // One retry round, then diagnose
    await autoPlay(25000);
    if (window.Game.run.battlesWon === before) {
      console.log('  STALL. screens:',
        ['Battle', 'Catch', 'Reward', 'Summary', 'Crossroads', 'GameOver', 'Title']
          .map((s) => s + '=' + !doc.getElementById('screen' + s).hidden).join(' '),
        'coachOpen=' + window.Modal.isOpen('screenCoach'),
        'locked=' + (window.Coach ? window.Coach.actionLocked() : false));
      const rr = window.Game.run;
      const u = window.Game.ui;
      console.log('  STALL state:', JSON.stringify({
        bag: rr.bag,
        section: rr.section, b: rr.battleInSection,
        prologue: rr.prologue,
        catchable: rr._battleCfg && rr._battleCfg.catchable,
        catchUsed: rr.catchUsedThisSection,
        damageDone: rr.tutorialDamageDone,
        catchDone: rr.tutorialCatchDone,
        balls: (u && u.s && u.s.balls) || null,
        moves: (u && u.s && u.s.moves || []).map((m) => m.id + (m.disabled ? ':D' : ':E')),
        msg: u && u.s.msg,
        enemyCfgHp: rr._battleCfg && rr._battleCfg.enemies && rr._battleCfg.enemies[0] && rr._battleCfg.enemies[0].hpPct,
        tutorialMoveId: rr._battleCfg && rr._battleCfg.tutorialMoveId,
        inBattle: rr._inBattle,
        lockUI: !!(u && u.s && u.s.locked),
        tutBeat: !!window.Game.tutorGuide,
      }));
      console.log('  thrown:', window.__thrown.slice(-5).join(' | '));
      console.log('  engine tail:');
      console.log(window.__eng.slice(-40).join('\n'));
      console.log('  pageErrors:', pageErrors.slice(-10).join(' \u00b7 '));
      break;    }
  }
  if (window.Game.run.over) { console.log('  run over (party wiped)'); break; }
  // After section 1 the scripted beats are done; keep tips ON for the rest.
  if (window.Game.run.section >= 2 && window.Game.run.prologue) {
    const spots = doc.querySelectorAll('.coach-spot');
    if (spots.length === 0) {
      console.log('  graduating the guided run at section', window.Game.run.section);
      window.Game.run.prologue = false;
      if (window.Coach) window.Coach.setPrologue(false);
      window.Coach.clearActionLock();
    }
  }
}
log('session-end');
check('played at least 4 battles (the tutorial window)', battles >= 4, `battles=${battles}`);

// ---- final accounting ---------------------------------------------------------
await wait(1500); // let trailing timers settle
log('settled');
window.Game.show('Title');
await wait(400);
log('back-at-title');

const first = LOG.find((s) => s.label === 'boot');
const end = LOG[LOG.length - 1];
check('exactly ONE WebGL renderer for the whole session (boot + N battles + title)',
  end.webglCreations === 1, `created=${end.webglCreations}`);
check('no canvas accumulation', end.canvases <= 1,
  `canvases=${end.canvases} (boot=${first.canvases})`);
check('battle host is clean after the last teardown',
  doc.querySelectorAll('#battleHost .bm-env, #battleHost .battle-hud, #battleHost .bm-sprites').length === 0);
check('timer count is bounded at the end', end.timers < 30, `timers=${end.timers}`);
check('rAF count is bounded at the end', end.rafs <= 2, `rafs=${end.rafs}`);
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));

const identities = LOG.filter((s) => s.label.startsWith('battle-start')).map((s) => s.uiCanvasSeq);
check('every battle shares the same renderer canvas', new Set(identities).size <= 1,
  `seqs=${identities.join(',')}`);

console.log('\n--- session timeline ---');
for (const s of LOG) {
  console.log(
    String(s.label).padEnd(22),
    `gl=${s.webglCreations} canvas=${s.canvases} timers=${s.timers} rafs=${s.rafs}`,
    `host=${s.battleHostChildren} env=${s.battleEnvs} hud=${s.battleHuds} spr=${s.battleSprites}`,
    `flat=${s.uiFlat ? 1 : 0} uiSeq=${s.uiCanvasSeq} conn=${s.uiCanvasInDom ? 1 : 0}`,
    `errs=${s.errors} bubbles=${s.bubbles} spots=${s.spots}`);
}

const failed = checks.filter((c) => !c.ok);
process.exitCode = failed.length ? 1 : 0;
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
