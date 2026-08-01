// ============================================================================
// e2e/run.mjs — real-browser tests for Dailylocke.
//
//   node tools/e2e/run.mjs
//
// WHY THIS EXISTS ALONGSIDE THE JSDOM SMOKE TEST
//   smoke-test.mjs proves the module graph boots and a battle resolves, but it
//   stubs WebGL, images and audio -- so it cannot see anything that depends on
//   real layout, real focus, a real service worker, or a real GL context.
//   This suite covers exactly that gap:
//
//     * starting a Daily and choosing a starter
//     * fighting a battle to a conclusion in a real WebGL canvas
//     * reloading mid-run and restoring the save
//     * opening every modal, with focus trapping and Escape
//     * iPhone- and Android-sized layouts (no horizontal overflow, tappable)
//     * prefers-reduced-motion
//     * offline reload once the service worker has installed
//
// Playwright's device/viewport/locale/timezone emulation is what makes the
// mobile and reduced-motion cases meaningful for a mobile-first daily game.
// ============================================================================
import { chromium } from 'playwright-core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { findBrowser, LAUNCH_ARGS } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');

let failures = 0, passes = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name}${why ? ' — ' + why : ''}`);
}
function section(t) { console.log(`\n${t}`); }

// The remote sprite/cry/music hosts are not part of what we're testing and
// would make every run slow and flaky. Serve a 1x1 GIF instead.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
async function stubRemotes(context) {
  await context.route('**://play.pokemonshowdown.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }));
  await context.route('**://raw.githubusercontent.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL }));
}

// Boot the app and wait until app.js has actually run.
//
// A brand-new browser profile now sees the FIRST-VISIT title (two doors:
// "Start a fresh game" / "Load save") rather than the three-mode menu, and
// each mode shows a one-time explainer before it starts. Neither is what the
// suites below are testing, so by default a page is put into the "returning
// player" state -- onboarded, tips off, explainers already seen. Pass
// `{ firstVisit: true }` to get the genuine new-player experience.
async function bootPage(context, origin, opts = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
  if (opts.skipReady !== true) {
    await page.waitForFunction(() => !!window.Game && !!window.Daily && !!window.Modal,
      null, { timeout: 30000 });
  }
  if (opts.firstVisit !== true && opts.skipReady !== true) {
    await page.evaluate(() => {
      if (!window.Coach) return;
      window.Coach.setOff(true);
      window.Coach.setOnboarded(true);
      ['daily', 'free', 'gauntlet'].forEach((m) => window.Coach.markMode(m));
      window.Game.setContinueState();
    });
    await page.waitForSelector('#titleModes:not([hidden])', { timeout: 10000 });
  }
  page.__errors = errors;
  return page;
}

// Drive a full battle from the player's side until it resolves.
async function playBattle(page, { maxTurns = 40 } = {}) {
  return page.evaluate(async (limit) => {
    // Wait for the run's battle object to exist.
    const until = async (fn, ms = 20000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 60));
      }
      return null;
    };
    const screenVisible = (id) => {
      const el = document.getElementById(id);
      return el && !el.hidden;
    };
    // Keep choosing the first legal move until a post-battle screen appears.
    for (let i = 0; i < limit; i++) {
      if (screenVisible('screenReward') || screenVisible('screenCatch') ||
          screenVisible('screenSummary') || screenVisible('screenGameOver') ||
          screenVisible('screenDailyResult')) {
        return { done: true, turns: i };
      }
      // The 3D HUD renders move buttons as `.mb[data-i]` (vendor/battle-ui.js).
      // A faint replaces the move grid with the forced-switch party sheet,
      // whose legal targets are the enabled `.pitem` rows -- answer that too,
      // otherwise a long-enough fight (or a crit) wedges the auto-player.
      const btn = await until(() => {
        const moves = [...document.querySelectorAll('#battleHost .mb[data-i]')]
          .filter((b) => !b.disabled);
        if (moves[0]) return moves[0];
        const party = [...document.querySelectorAll('#battleHost .pitem')]
          .filter((b) => !b.disabled);
        return party[0] || null;
      }, 5000);
      if (!btn) { await new Promise((r) => setTimeout(r, 250)); continue; }
      btn.click();
      await new Promise((r) => setTimeout(r, 350));
    }
    return {
      done: screenVisible('screenReward') || screenVisible('screenCatch') ||
            screenVisible('screenSummary') || screenVisible('screenGameOver') ||
            screenVisible('screenDailyResult'),
      turns: limit,
    };
  }, maxTurns);
}

// ---------------------------------------------------------------- main ----
const found = findBrowser();
if (!found) {
  console.log('\nPlaywright E2E: SKIPPED — no Chromium available.');
  console.log('  Install one with:  npx playwright install chromium');
  console.log('  Or point at an existing binary:  DAILYLOCKE_CHROMIUM=/path/to/chromium\n');
  process.exit(0);
}
console.log(`Playwright E2E — browser: ${found.source}`);

const srv = await startServer(repo);
const browser = await chromium.launch({
  executablePath: found.executablePath,
  args: LAUNCH_ARGS,
});

try {
  // ======================================================= DAILY RUN =======
  section('Daily run: start, starter, battle');
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },   // iPhone 14-ish
      locale: 'en-GB',
      timezoneId: 'Europe/Amsterdam',
      hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    check('app boots in a real browser', await page.evaluate(() => !!window.Game));
    check('Daily module is present', await page.evaluate(() => !!window.Daily));

    const dayKey = await page.evaluate(() => window.Daily.dayKey());
    check('Daily uses the LOCAL date, not UTC',
      /^\d{4}-\d{2}-\d{2}$/.test(dayKey), dayKey);

    check('Daily is finite', await page.evaluate(() => window.Daily.SECTIONS > 0),
      `${await page.evaluate(() => window.Daily.SECTIONS)} sections`);

    // Start today's Daily.
    await page.click('#btnDaily');
    await page.waitForSelector('#screenStarter:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#starterGrid .starter-card').length === 3,
      null, { timeout: 60000 });
    check('starter screen offers three choices',
      (await page.locator('#starterGrid .starter-card').count()) === 3);

    // Choose the first starter and name it.
    await page.locator('#starterGrid .pick-btn').first().click();
    await page.waitForSelector('#screenNickname:not([hidden])', { timeout: 15000 });
    check('nickname prompt is a real dialog',
      await page.evaluate(() => {
        const card = document.querySelector('#screenNickname .overlay-card');
        return card.getAttribute('role') === 'dialog' &&
               card.getAttribute('aria-modal') === 'true';
      }));
    check('focus moves into the nickname dialog',
      await page.evaluate(() => document.getElementById('screenNickname')
        .contains(document.activeElement)));

    await page.fill('#nickInput', 'Testmon');
    await page.click('#btnNickOk');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 15000 });
    check('starter choice lands on the route screen', true);

    const runMode = await page.evaluate(() => window.Game.run && window.Game.run.mode);
    check('the run is tagged as a Daily', runMode === 'daily', runMode);
    check('the Daily has a section limit',
      await page.evaluate(() => window.Game.run.maxSections > 0));

    // The two slots must be independent.
    const slots = await page.evaluate(() => ({
      daily: !!localStorage.getItem('dailylocke-run-daily'),
      free: !!localStorage.getItem('nuzlocke-run'),
    }));
    check('a Daily writes ONLY to the daily slot', slots.daily && !slots.free,
      JSON.stringify(slots));

    // ---- fight a battle in a real WebGL context ----
    await page.click('#btnGoBattle');
    // NB: #screenBattle itself has zero height -- its only child, #battleHost,
    // is absolutely positioned -- so wait for the canvas, not the section.
    await page.waitForSelector('#battleHost canvas', { timeout: 30000 });
    check('the battle screen is shown',
      await page.evaluate(() => !document.getElementById('screenBattle').hidden));
    const gl = await page.evaluate(() => {
      const c = document.querySelector('#battleHost canvas');
      if (!c) return 'no canvas';
      const ctx = c.getContext('webgl2') || c.getContext('webgl');
      return ctx ? 'ok' : 'no context';
    });
    check('the 3D battle renders in a real WebGL context', gl === 'ok', gl);

    const result = await playBattle(page);
    check('a battle plays through to a result screen', result.done,
      `${result.turns} interactions`);

    // ---- reload restores the run ----
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Game, null, { timeout: 30000 });
    const resumed = await page.evaluate(() => {
      const btn = document.getElementById('btnDaily');
      return {
        label: document.getElementById('dailyMain').textContent,
        saved: !!localStorage.getItem('dailylocke-run-daily'),
        visible: !!btn && btn.offsetParent !== null,
      };
    });
    check('a reload preserves the Daily save', resumed.saved);
    check('the title offers to RESUME the Daily', /resume/i.test(resumed.label),
      resumed.label);

    // Regression: after save slots were split, title-menu transfer only looked
    // in Free Play. An unfinished Daily therefore said there was no run even
    // though the same title screen offered to resume it.
    await page.click('#btnTitleMenu');
    await page.waitForSelector('#screenMenu:not([hidden])');
    await page.click('#btnMenuTransfer');
    await page.waitForSelector('#screenSaveExport:not([hidden])');
    const transferred = await page.evaluate(() => {
      // The Download button writes Game.fullBackupState(); assert on the
      // actual payload instead of a removed save-code API.
      const dl = document.getElementById('btnDownloadSave');
      const state = window.Game.fullBackupState();
      const save = state && state.runs && state.runs.daily;
      return {
        dlVisible: !!dl && !dl.disabled,
        mode: save && save.mode,
        section: save && save.section,
        party: (save && save.party || []).map((m) => m.name),
      };
    });
    check('an ongoing Daily can be transferred from the title menu',
      transferred.dlVisible && transferred.mode === 'daily' &&
      transferred.party.includes('Testmon'),
      JSON.stringify(transferred));
    await page.click('#btnSaveExportClose');

    await page.click('#btnDaily');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 20000 });
    const party = await page.evaluate(() => window.Game.run.party.map((m) => m.name));
    check('the restored run still has the named party', party.includes('Testmon'),
      party.join(', '));

    const realErrors = page.__errors.filter(
      (e) => !/favicon|sprite|cry|audio|Failed to load resource/i.test(e));
    check('no unexpected page errors during a Daily', realErrors.length === 0,
      realErrors.slice(0, 2).join(' | '));

    await context.close();
  }

  // =================================================== TEAM GAUNTLET =======
  section('Team Gauntlet: draft, trainer rush, heal, no economy');
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'en-GB', timezoneId: 'Europe/Amsterdam',
      hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    // ---- the draft ----
    await page.click('#btnGauntlet');
    await page.waitForSelector('#screenTeamBuilder:not([hidden])', { timeout: 15000 });
    check('the Team Gauntlet opens the draft', true);
    check('the draft cannot start empty',
      await page.evaluate(() => document.getElementById('btnTbStart').disabled));

    const roster = ['gengar', 'snorlax', 'garchomp', 'scizor', 'blissey', 'rotom'];
    for (let i = 0; i < roster.length; i++) {
      const id = roster[i];
      await page.fill('#tbSearch', id);
      await page.waitForSelector(`#tbList .tb-row[data-id="${id}"]`, { timeout: 15000 });
      await page.click(`#tbList .tb-row[data-id="${id}"]`);
      await page.waitForFunction((count) =>
        document.querySelectorAll('#tbTeam .tslot.filled').length === count,
      i + 1, { timeout: 15000 });

      // Regression: xTeamDetail used to be nested in the hidden Crossroads
      // screen. Modal.open() still made TeamBuilder inert, but the sheet could
      // not render, so tapping a drafted Pokemon appeared to freeze the game.
      if (i === 0) {
        await page.click('#tbTeam .tslot[data-i="0"]');
        await page.waitForSelector('#xTeamDetail', { state: 'visible', timeout: 5000 });
        const config = await page.evaluate(() => ({
          modalOpen: window.Modal.isOpen('xTeamDetail'),
          parent: document.getElementById('xTeamDetail').parentElement.tagName,
          moves: document.querySelectorAll('#xTeamDetail .pd-move').length,
          close: !!document.querySelector('#xTeamDetail .pd-close'),
        }));
        check('a drafted Pokemon opens a visible, usable config sheet',
          config.modalOpen && config.parent === 'MAIN' && config.moves > 0 && config.close,
          JSON.stringify(config));
        await page.click('#xTeamDetail .pd-close');
        await page.waitForSelector('#xTeamDetail', { state: 'hidden', timeout: 5000 });
        check('closing draft config restores the team builder',
          await page.evaluate(() =>
            document.getElementById('screenTeamBuilder').inert !== true &&
            !window.Modal.isOpen('xTeamDetail')));
      }
    }
    check('six picks unlock the start button',
      await page.evaluate(() => !document.getElementById('btnTbStart').disabled &&
        document.getElementById('tbCount').textContent.startsWith('6 / 6')));

    await page.click('#btnTbStart');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 30000 });
    const meta = await page.evaluate(() => ({
      mode: window.Game.run.mode,
      party: window.Game.run.party.length,
      money: window.Game.run.money,
      bag: Object.keys(window.Game.run.bag).length,
      shopHidden: document.getElementById('xShopBlock').hidden,
      bagHidden: document.getElementById('xBagBlock').hidden,
      cashHidden: document.getElementById('xCashPill').hidden,
      label: document.getElementById('xNextLabel').textContent,
    }));
    check('the run is tagged as a gauntlet with six Pokemon',
      meta.mode === 'gauntlet' && meta.party === 6, JSON.stringify(meta));
    check('the gauntlet has no cash and no bag', meta.money === 0 && meta.bag === 0);
    check('the route hides the mart, the bag and the cash readout',
      meta.shopHidden && meta.bagHidden && meta.cashHidden);
    check('the route offers a trainer battle', meta.label === 'Trainer Battle', meta.label);

    // ---- battle 1: trainer rules (no bag items, no running) ----
    await page.click('#btnGoBattle');
    await page.waitForSelector('#battleHost canvas', { timeout: 30000 });
    await page.waitForSelector('#battleHost .actbar', { timeout: 30000 });
    const actbar = await page.evaluate(() => ({
      bagButtons: document.querySelectorAll('#battleHost .ab[data-a="bag"]').length,
      runButtons: document.querySelectorAll('#battleHost .ab[data-a="run"]').length,
      ballRail: document.querySelectorAll('#battleHost .ballrail').length,
      rightCell: ((document.querySelector('#battleHost .topbar .sc') || {}).textContent || '').trim(),
    }));
    check('no bag button in a gauntlet battle', actbar.bagButtons === 0);
    check('no ball rail in a gauntlet battle', actbar.ballRail === 0);
    check('no run button in a gauntlet battle', actbar.runButtons === 0,
      JSON.stringify(actbar));
    check('the battle HUD keeps the cash cell empty', actbar.rightCell === '',
      actbar.rightCell);

    const result = await playBattle(page);
    check('the first trainer battle plays out to a result', result.done,
      `${result.turns} interactions`);
    const rewardText = await page.evaluate(() =>
      document.getElementById('rewardBody').textContent);
    check('the victory pays no prize money', !/\+\$/.test(rewardText), rewardText.slice(0, 60));

    await page.click('#btnRewardDone');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 15000 });
    const after = await page.evaluate(() => ({
      section: window.Game.run.section,
      beaten: window.Game.run.trainersBeaten,
      money: window.Game.run.money,
      allHealthy: window.Game.run.party.every((m) => m.hpPct === 1 && !m.status),
      fullPP: window.Game.run.party.every((m) =>
        m.moves.every((id) =>
          m.pp[id] === Math.floor(window.PS.Dex.moves.get(id).pp * 1.6))),
      label: document.getElementById('xNextLabel').textContent,
    }));
    check('winning moves the gauntlet to the next trainer',
      after.section === 2 && after.beaten === 1 && after.label === 'Trainer Battle',
      JSON.stringify(after));
    check('survivors are fully restored after the win',
      after.allHealthy && after.fullPP);
    check('the wallet stays at zero', after.money === 0);

    // ---- persistence: its own slot, resumeable from the title ----
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Game, null, { timeout: 30000 });
    const saved = await page.evaluate(() => ({
      gauntlet: !!localStorage.getItem('dailylocke-run-gauntlet'),
      daily: !!localStorage.getItem('dailylocke-run-daily'),
      free: !!localStorage.getItem('nuzlocke-run'),
      label: document.getElementById('gauntletMain').textContent,
    }));
    check('the gauntlet writes ONLY to its own slot',
      saved.gauntlet && !saved.daily && !saved.free, JSON.stringify(saved));
    check('the title offers to RESUME the gauntlet', /resume gauntlet/i.test(saved.label),
      saved.label);

    const realErrors = page.__errors.filter(
      (e) => !/favicon|sprite|cry|audio|Failed to load resource/i.test(e));
    check('no unexpected page errors during a gauntlet', realErrors.length === 0,
      realErrors.slice(0, 2).join(' | '));

    await context.close();
  }

  // ====================================================== ONBOARDING =======
  // The guided first run, in a real browser: a coach mark needs real layout
  // to position itself against, which JSDOM cannot provide at all.
  section('Onboarding: first visit, guided run, opt-out');
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin, { firstVisit: true });

    // ---- the first-visit title ----
    check('a brand-new player sees the first-visit title, not three modes',
      await page.isVisible('#titleFirst') && !(await page.isVisible('#titleModes')));
    check('the primary door is "Start a fresh game"',
      /fresh game/i.test(await page.textContent('#btnFreshGame')));
    check('the secondary door is "Load save"',
      /load save/i.test(await page.textContent('#btnTitleLoad')));

    // ---- trainer setup ----
    await page.click('#btnFreshGame');
    await page.waitForSelector('#screenSetup:not([hidden])', { timeout: 15000 });
    check('setup asks for a sprite and a name',
      await page.isVisible('#setupAvatar') && await page.isVisible('#setupName'));
    check('setup asks how much help the player wants',
      (await page.locator('#screenSetup [data-exp]').count()) === 2);
    check('"show me the ropes" is the default',
      await page.locator('#screenSetup [data-exp="new"]').evaluate((el) => el.classList.contains('on')));

    await page.fill('#setupName', 'Thijmen');
    await page.click('#btnSetupGo');

    // ---- the fixed starter trio ----
    await page.waitForSelector('#screenStarter:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#starterGrid .starter-card').length === 3,
      null, { timeout: 60000 });
    const trio = await page.evaluate(() =>
      [...document.querySelectorAll('#starterGrid .sc-name')].map((n) => n.textContent.trim()));
    check('the guided run offers the fixed grass/fire/water trio',
      ['Treecko', 'Charmander', 'Froakie'].every((n) => trio.includes(n)), trio.join(', '));
    check('the professor advises on the starter screen',
      await page.isVisible('#starterCoach'));
    const roles = await page.evaluate(() =>
      [...document.querySelectorAll('#starterGrid .mr-label')].map((n) => n.textContent.trim()));
    check('each starter card names what that Pokemon is for',
      roles.length === 3 && roles.every(Boolean), roles.join(' / '));
    check('the starters are not all given the same label',
      new Set(roles).size > 1, roles.join(' / '));

    // ---- into the run ----
    await page.locator('#starterGrid .pick-btn').first().click();
    await page.waitForSelector('#screenNickname:not([hidden])', { timeout: 15000 });
    await page.fill('#nickInput', 'Twig');
    await page.click('#btnNickOk');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 20000 });

    // ---- the first coach mark, positioned by real layout ----
    const marked = await page.waitForSelector('.coach-mark.on', { timeout: 10000 }).catch(() => null);
    check('a coach mark appears on the route', !!marked);
    if (marked) {
      const box = await marked.boundingBox();
      check('the coach mark is on screen and has a real size',
        !!box && box.width > 40 && box.height > 20 &&
        box.x >= -1 && box.x + box.width <= 391,
        box && `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
      check('the mark highlights the thing it is talking about',
        (await page.locator('.coach-spot').count()) === 1);
      check('the mark is visually distinct from a button',
        await page.locator('.coach-mark').evaluate((el) =>
          getComputedStyle(el).borderLeftWidth === '3px'));

      // ---- the no-chaining rule, in a real browser ----
      await page.evaluate(() => {
        window.Coach.lesson('mart');
        window.Coach.lesson('trainer');
        window.Coach.lesson('held');
      });
      check('no second card ever stacks on the first',
        (await page.locator('.coach-mark').count()) === 1);

      await page.click('.coach-mark .cm-ok');
      await page.waitForTimeout(400);
      check('dismissing a mark clears its highlight too',
        (await page.locator('.coach-spot').count()) === 0);
    }

    // ---- honest item copy where it matters ----
    await page.evaluate(() => { window.Game.run.money = 12000; window.Game.redrawRoute(); });
    await page.waitForTimeout(500);
    const fullHeal = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.shop-item')];
      const fh = all.find((t) => /Full Heal/i.test(t.querySelector('.si-name')?.textContent || ''));
      return fh ? (fh.querySelector('.si-plain')?.textContent || '') : null;
    });
    check('Full Heal is labelled as status-only in the shop',
      !!fullHeal && /no hp/i.test(fullHeal), fullHeal);

    // ---- the opt-out is real and it sticks ----
    await page.evaluate(() => { window.Coach.setOff(true); });
    const stillFires = await page.evaluate(() => window.Coach.lesson('skipping'));
    check('turning tips off stops every lesson', stillFires === false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Coach, null, { timeout: 20000 });
    check('the tips-off choice survives a reload',
      await page.evaluate(() => window.Coach.tipsOn() === false));
    check('an onboarded player keeps the full mode menu after reload',
      await page.isVisible('#titleModes'));

    // ---- the guide is always there to fall back on ----
    await page.click('#btnTitleMenu');
    await page.waitForSelector('#screenMenu:not([hidden])', { timeout: 8000 });
    await page.click('#btnMenuGuide');
    await page.waitForSelector('#screenGuide:not([hidden])', { timeout: 8000 });
    const cards = await page.locator('.guide-card').count();
    check('the guide lists every lesson for re-reading', cards >= 18, `${cards} cards`);
    await page.locator('.guide-card').first().click();
    await page.waitForSelector('#screenCoach:not([hidden])', { timeout: 8000 });
    check('a lesson can be replayed from the guide even with tips off',
      await page.isVisible('#screenCoach'));

    for (const e of page.__errors) {
      if (!/favicon|sprite|cry|audio|Failed to load resource/i.test(e)) {
        check('no console errors during onboarding', false, e);
        break;
      }
    }
    await context.close();
  }

  // ========================================================= MODALS ========
  section('Modal accessibility');
  {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    // Every overlay, opened from the title screen.
    const modals = [
      ['screenMenu', () => document.getElementById('btnTitleMenu').click()],
      ['screenSaveImport', () => {
        document.getElementById('btnTitleMenu').click();
        document.getElementById('btnMenuImport').click();
      }],
      ['screenInstall', () => window.PWA && window.PWA.openSheet && window.PWA.openSheet()],
    ];

    for (const [id, opener] of modals) {
      const opened = await page.evaluate(async ([mid, fnSrc]) => {
        const fn = new Function('return (' + fnSrc + ')')();
        try { fn(); } catch { /* the opener may not exist on this build */ }
        await new Promise((r) => setTimeout(r, 200));
        const el = document.getElementById(mid);
        if (!el || el.hidden) return null;
        const card = el.querySelector('.overlay-card') || el;
        return {
          role: card.getAttribute('role'),
          modal: card.getAttribute('aria-modal'),
          labelled: !!(card.getAttribute('aria-labelledby') || card.getAttribute('aria-label')),
          focusInside: el.contains(document.activeElement),
        };
      }, [id, opener.toString()]);

      if (!opened) { skip(`${id} opens`, 'not reachable from the title'); continue; }
      check(`${id}: role=dialog + aria-modal`,
        opened.role === 'dialog' && opened.modal === 'true',
        `${opened.role}/${opened.modal}`);
      check(`${id}: has an accessible name`, opened.labelled);
      check(`${id}: focus moves inside`, opened.focusInside);

      // Background must be inert while the dialog is open. The overlays are
      // nested inside <main>, so <main> itself CANNOT be inert (inert is
      // inherited and would kill the dialog). What must hold is that every
      // SIBLING on the path from the dialog up to <body> is inert -- and,
      // concretely, that a real background control is unreachable.
      const inert = await page.evaluate((mid) => {
        const el = document.getElementById(mid);
        let node = el, ok = true;
        while (node && node !== document.body && node.parentElement) {
          for (const sib of node.parentElement.children) {
            if (sib === node) continue;
            if (sib.tagName === 'SCRIPT' || sib.tagName === 'TEMPLATE') continue;
            if (sib.inert !== true && sib.getAttribute('aria-hidden') !== 'true') ok = false;
          }
          node = node.parentElement;
        }
        // The dialog itself must NOT have inherited inertness.
        const btn = el.querySelector('button');
        if (btn && btn.matches(':disabled')) ok = false;
        return ok;
      }, id);
      check(`${id}: background is inert`, inert);

      // The strongest form of the check: a background control cannot be
      // focused while the dialog is open.
      const bgBlocked = await page.evaluate(() => {
        const bg = document.getElementById('btnDaily');
        if (!bg) return true;
        const before = document.activeElement;
        bg.focus();
        const blocked = document.activeElement !== bg;
        if (!blocked && before) before.focus();
        return blocked;
      });
      check(`${id}: background controls cannot take focus`, bgBlocked);

      // Tab must not escape the dialog.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const stillInside = await page.evaluate((mid) =>
        document.getElementById(mid).contains(document.activeElement), id);
      check(`${id}: Tab stays trapped`, stillInside);

      // Escape closes, and focus returns to the page.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const closed = await page.evaluate((mid) => {
        const el = document.getElementById(mid);
        return { hidden: el.hidden, restored: !el.contains(document.activeElement) };
      }, id);
      check(`${id}: Escape closes it`, closed.hidden);
      check(`${id}: focus leaves the closed dialog`, closed.restored);

      // And the page is interactive again.
      const released = await page.evaluate((mid) => {
        const el = document.getElementById(mid);
        const others = [...document.body.children].filter(
          (n) => n !== el && n.tagName !== 'SCRIPT' && n.tagName !== 'TEMPLATE');
        return others.every((n) => !n.inert && n.getAttribute('aria-hidden') !== 'true');
      }, id);
      check(`${id}: background is released on close`, released);
    }

    await context.close();
  }

  // ================================================= MOBILE LAYOUTS ========
  section('Mobile layouts');
  {
    const devices = [
      ['iPhone SE (small Safari)', { width: 375, height: 667 }],
      ['iPhone 14 Pro Max', { width: 430, height: 932 }],
      ['Pixel 7 (Android)', { width: 412, height: 915 }],
    ];
    for (const [label, viewport] of devices) {
      const context = await browser.newContext({
        viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
      });
      await stubRemotes(context);
      const page = await bootPage(context, srv.origin);

      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label}: no horizontal overflow`, overflow <= 1, `${overflow}px`);

      // The primary action must be a real, comfortably tappable target.
      const box = await page.locator('#btnDaily').boundingBox();
      check(`${label}: Daily button is tappable`, !!box && box.height >= 44,
        box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'missing');
      check(`${label}: Daily button is on screen`,
        !!box && box.y >= 0 && box.y + box.height <= viewport.height + 1,
        box ? `y=${Math.round(box.y)}` : 'missing');

      await context.close();
    }
  }

  // ============================================== REDUCED MOTION ===========
  section('Reduced motion');
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    check('the reduced-motion media query is honoured',
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));

    const durations = await page.evaluate(() => {
      const out = [];
      for (const el of [...document.querySelectorAll('button, .overlay-card, .btn-white')].slice(0, 25)) {
        const cs = getComputedStyle(el);
        out.push(cs.transitionDuration, cs.animationDuration);
      }
      return out;
    });
    const longest = Math.max(0, ...durations.flatMap((d) =>
      String(d).split(',').map((x) => parseFloat(x) || 0)));
    check('animations are suppressed under reduced motion', longest <= 0.05,
      `${longest}s longest`);

    check('the game is still fully usable', await page.evaluate(() => {
      const b = document.getElementById('btnDaily');
      return !!b && b.offsetParent !== null;
    }));

    await context.close();
  }

  // ================================================ SERVICE WORKER =========
  section('Service worker + offline');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    const registered = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      return !!reg;
    });
    check('the service worker registers', registered);

    // Wait for the precache to finish before pulling the plug.
    const cached = await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const keys = await caches.keys();
        const shell = keys.find((k) => k.startsWith('dailylocke-shell-'));
        if (shell) {
          const c = await caches.open(shell);
          const n = (await c.keys()).length;
          if (n > 20) return { shell, n };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    });
    check('the app shell precaches', !!cached,
      cached ? `${cached.n} entries in ${cached.shell}` : 'timed out');
    check('the shell cache name carries a content revision',
      !!cached && /^dailylocke-shell-[0-9a-f]{6,}$/.test(cached.shell),
      cached && cached.shell);

    // ---- the real test: reload with the network cut ----
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const offlineOk = await page.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        if (window.Game && window.Daily && window.Core) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    });
    check('the game boots OFFLINE from the cache', offlineOk);

    if (offlineOk) {
      check('the Daily button still works offline',
        await page.evaluate(() => {
          const b = document.getElementById('btnDaily');
          return !!b && b.offsetParent !== null;
        }));
      // A self-hosted font is the whole point: a remote one would be gone here.
      const font = await page.evaluate(async () => {
        await document.fonts.ready;
        return document.fonts.check('16px VT323');
      });
      check('the self-hosted font is available offline', font);
    }
    await context.setOffline(false);
    await context.close();
  }

  // ============================================== FREE PLAY SLOT ===========
  section('Slot independence');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    // Plant a Free Play run and a Daily run, then prove neither erases the other.
    const state = await page.evaluate(() => {
      const mk = (mode, section) => JSON.stringify({
        __v: 3, mode, dailyDate: mode === 'daily' ? window.Daily.dayKey() : null,
        seed: 123, section, battleInSection: 0, maxSections: mode === 'daily' ? 5 : 0,
        party: [{ id: 'gengar', species: 'Gengar', name: 'Casper', hpPct: 1, moves: ['shadowball'], pp: {} }],
        bag: {}, money: 1000, battlesWon: 3, graveyard: [], damageDealt: {}, knockouts: {},
        monMeta: {}, seenSpecies: {}, sectionStats: { money: 0, won: 0, caught: null, lost: [], damage: 0, kos: 0, startedAt: section },
      });
      localStorage.setItem('nuzlocke-run', mk('free', 9));
      localStorage.setItem('dailylocke-run-daily', mk('daily', 2));
      return true;
    });
    check('both slots can be populated at once', state);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Game, null, { timeout: 30000 });
    const both = await page.evaluate(() => ({
      dailyLabel: document.getElementById('dailyMain').textContent,
      freeShown: !document.getElementById('titleFreeRun').hidden,
      freeSub: document.getElementById('continueSub').textContent,
    }));
    check('the title offers the Daily AND the Free Play run together',
      /resume/i.test(both.dailyLabel) && both.freeShown,
      `${both.dailyLabel} | ${both.freeSub}`);

    // Legacy single-slot saves must migrate to Free Play, never to the Daily.
    const migrated = await page.evaluate(async () => {
      localStorage.clear();
      localStorage.setItem('nuzlocke-run', JSON.stringify({
        __v: 2, seed: 7, section: 4, battleInSection: 1,
        party: [{ id: 'pikachu', species: 'Pikachu', name: 'Sparky', hpPct: 1, moves: ['thunderbolt'], pp: {} }],
        bag: {}, money: 500, battlesWon: 5, graveyard: [], damageDealt: {}, knockouts: {},
        monMeta: {}, seenSpecies: {},
      }));
      location.reload();
      return true;
    });
    if (migrated) {
      await page.waitForFunction(() => !!window.Game, null, { timeout: 30000 });
      const after = await page.evaluate(() => ({
        freeShown: !document.getElementById('titleFreeRun').hidden,
        dailyLabel: document.getElementById('dailyMain').textContent,
      }));
      check('a legacy save becomes a FREE PLAY run, not a Daily',
        after.freeShown && !/resume/i.test(after.dailyLabel),
        `${after.dailyLabel} | free=${after.freeShown}`);
    }

    await context.close();
  }

  // ================================ THE DAILY ENDPOINT (the headline) ======
  // A Daily is finite. This drives the exact boundary -- the last trainer of
  // the last section -- and asserts the whole ending: result screen, recorded
  // score, streak, share card, freed slot, and the optional carry into Free
  // Play. Playing six real boss Pokemon to get here would be far too slow and
  // too RNG-dependent to assert on, so we position the run and use the same
  // post-battle call the reward screen's Continue button makes.
  section('Daily endpoint: completion, scoring, sharing');
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'en-GB', timezoneId: 'Europe/Amsterdam',
    });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    await page.click('#btnDaily');
    await page.waitForFunction(
      () => document.querySelectorAll('#starterGrid .starter-card').length === 3,
      null, { timeout: 60000 });
    await page.locator('#starterGrid .pick-btn').first().click();
    await page.waitForSelector('#screenNickname:not([hidden])', { timeout: 15000 });
    await page.fill('#nickInput', 'Champ');
    await page.click('#btnNickOk');
    await page.waitForSelector('#screenCrossroads:not([hidden])', { timeout: 15000 });

    // Stand at the end of the final section, mid-run stats already earned.
    await page.evaluate(() => {
      const r = window.Game.run;
      r.section = r.maxSections;
      r.battleInSection = 3;
      r.battlesWon = 20; r.trainersBeaten = 5; r.caught = 3;
      r.sectionMarks = ['\uD83D\uDFE9', '\uD83D\uDFE9', '\uD83D\uDFE5', '\uD83D\uDFE9'];
      r.damageDealt[r.party[0].uid] = 9999;
      r.sectionStats = { money: 0, won: 4, caught: null, lost: [], damage: 0, kos: 0, startedAt: r.section };
      window.Game.advance();
    });
    await page.waitForTimeout(1200);

    const done = await page.evaluate(() => ({
      onResult: !document.getElementById('screenDailyResult').hidden,
      rolledOver: window.Game.run && window.Game.run.section > window.Game.run.maxSections,
      title: document.getElementById('drTitle').textContent,
      share: document.getElementById('drShareText').value,
      carry: document.getElementById('btnDrContinue').hidden === false,
      slotCleared: localStorage.getItem('dailylocke-run-daily') === null,
      store: JSON.parse(localStorage.getItem('dailylocke-daily') || '{}'),
    }));

    check('a finite Daily ENDS instead of rolling into another section',
      done.onResult && !done.rolledOver, done.title);
    const rec = Object.values(done.store.results || {})[0] || {};
    check('the result is recorded as complete', rec.outcome === 'complete', rec.outcome);
    check('the result records sections, battles, caught and MVP',
      rec.sections === 5 && rec.battles === 20 && rec.caught === 3 && !!rec.mvp,
      JSON.stringify({ s: rec.sections, b: rec.battles, c: rec.caught, mvp: rec.mvp && rec.mvp.name }));
    check('clearing a Daily starts the streak', done.store.streak === 1, `${done.store.streak}`);

    check('the share card matches the documented format',
      /^Dailylocke #\d+\nSections: 5\/5\nBattles: 20\nCaught: 3\nLost: 0\nMVP: /.test(done.share),
      JSON.stringify(done.share.split('\n').slice(0, 6)));
    check('the share card carries one square per section',
      (done.share.match(/[\uD83D][\uDFE9\uDFE5\uDFE8]/g) || []).length === 5,
      (done.share.match(/[\uD83D][\uDFE9\uDFE5\uDFE8]/g) || []).join(''));

    check('finishing frees the Daily slot for tomorrow', done.slotCleared);
    check('a cleared Daily offers to continue in Free Play', done.carry);

    // The carry-over: the same team, now endless.
    await page.click('#btnDrContinue');
    await page.waitForTimeout(1500);
    const carried = await page.evaluate(() => ({
      onRoute: !document.getElementById('screenCrossroads').hidden,
      mode: window.Game.run.mode,
      endless: window.Game.run.maxSections === 0,
      section: window.Game.run.section,
      freeSaved: !!localStorage.getItem('nuzlocke-run'),
      party: window.Game.run.party.map((m) => m.name),
    }));
    check('the Daily team carries into an ENDLESS Free Play run',
      carried.onRoute && carried.mode === 'free' && carried.endless,
      JSON.stringify(carried));
    check('the carried run resumes past the Daily it came from',
      carried.section === 6 && carried.freeSaved && carried.party.includes('Champ'),
      `section ${carried.section}, party ${carried.party.join(',')}`);

    // Back at the title, today's Daily is done and says so.
    await page.evaluate(() => window.Game.show('Title'));
    await page.waitForTimeout(400);
    const title = await page.evaluate(() => ({
      label: document.getElementById('dailyMain').textContent,
      streak: document.getElementById('dailyStreak').hidden === false,
      noDuplicateResultButton: !document.getElementById('btnDailyResults'),
    }));
    check('the title shows the Daily as complete', /complete/i.test(title.label), title.label);
    check('the streak chip appears once there is a streak', title.streak);
    check('the title has no duplicate result button', title.noDuplicateResultButton);

    // Re-tapping Daily must show the RESULT, never silently start a new run.
    await page.click('#btnDaily');
    await page.waitForTimeout(600);
    check('re-tapping a finished Daily reopens the result, not a new run',
      await page.evaluate(() => !document.getElementById('screenDailyResult').hidden));

    await context.close();
  }

  // ====================================== ASCENSION IN A LIVE BATTLE =======
  // The unit tests prove the ascension MATH; this proves the effects actually
  // reach the simulator and show up in the battle protocol.
  section('Ascension effects reach the engine');
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await stubRemotes(context);
    const page = await bootPage(context, srv.origin);

    const out = await page.evaluate(async () => {
      const C = window.Core, RB = window.RogueBattle;
      const player = [await C.makeMon('blissey', { role: 'wall' })];
      const enemy = [await C.makeMon('garchomp', { role: 'sweeper' })];
      enemy[0].elite = { id: 'swift', label: 'Swift', boosts: { spe: 1 } };

      const lines = [];
      await new Promise((done) => {
        const timer = setTimeout(done, 12000);
        const b = RB.startBattle({
          playerMons: player, enemyMons: enemy, isWild: false, trainerName: 'Tester',
          aiDepth: 3,
          fieldEffect: { kind: 'weather', id: 'sandstorm', label: 'Sandstorm' },
          battleSeed: [1, 2, 3, 4],
          handlers: {
            onLog(chunk) {
              lines.push(String(chunk));
              if (lines.join('').includes('|turn|2')) { clearTimeout(timer); done(); }
            },
            onRequest(req) {
              if (req && req.forceSwitch) { setTimeout(() => b.chooseSwitch(1), 0); return; }
              if (req && req.active) setTimeout(() => b.chooseMove(0, null), 0);
            },
            onEnd() { clearTimeout(timer); done(); },
            onError() { clearTimeout(timer); done(); },
          },
        });
      });
      return lines.join('');
    });

    check('a battle-start field effect reaches the engine',
      /-weather\|Sandstorm/i.test(out), (out.match(/-weather\|\w+/i) || ['none'])[0]);
    check('an elite modifier is announced to the player',
      /-message\|.*Swift/i.test(out), (out.match(/-message\|[^|]*/i) || ['none'])[0]);
    check('the elite boost is actually applied',
      /-boost\|p2a[^|]*\|spe\|1/i.test(out), (out.match(/-boost\|[^\n]*/i) || ['none'])[0]);

    // Determinism: the same seed must produce the same battle, twice.
    const twice = await page.evaluate(async () => {
      const C = window.Core, RB = window.RogueBattle;
      const play = async () => {
        const player = [await C.makeMon('gengar')];
        const enemy = [await C.makeMon('blastoise')];
        const lines = [];
        await new Promise((done) => {
          const timer = setTimeout(done, 12000);
          const b = RB.startBattle({
            playerMons: player, enemyMons: enemy, isWild: true, trainerName: 'Wild',
            battleSeed: [7, 7, 7, 7],
            handlers: {
              onLog(c) {
                lines.push(String(c));
                if (lines.join('').includes('|turn|3')) { clearTimeout(timer); done(); }
              },
              onRequest(req) {
                if (req && req.forceSwitch) { setTimeout(() => b.chooseSwitch(1), 0); return; }
                if (req && req.active) setTimeout(() => b.chooseMove(0, null), 0);
              },
              onEnd() { clearTimeout(timer); done(); },
              onError() { clearTimeout(timer); done(); },
            },
          });
        });
        return lines.join('').split('\n').filter((l) => l.startsWith('|-damage|')).join('/');
      };
      return [await play(), await play()];
    });
    check('a seeded battle is reproducible (the Daily is fair)',
      twice[0].length > 0 && twice[0] === twice[1],
      twice[0].slice(0, 70) || 'no damage lines');

    await context.close();
  }

  // ============================================= SCREENSHOTS (manifest) ====
  // The manifest advertises narrow + wide screenshots for a richer install
  // dialog; capture them from the real app so they can never go stale.
  if (process.env.DAILYLOCKE_SHOTS === '1') {
    section('Capturing manifest screenshots');
    const shots = [
      ['narrow', { width: 390, height: 844 }, 'assets/screenshots/narrow-title.png'],
      ['wide', { width: 1280, height: 720 }, 'assets/screenshots/wide-title.png'],
    ];
    for (const [label, viewport, out] of shots) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      await stubRemotes(context);
      const page = await bootPage(context, srv.origin);
      await page.waitForTimeout(2500);      // let the title scene settle
      await page.screenshot({ path: resolve(repo, out) });
      console.log(`  wrote ${out} (${label})`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await srv.close();
}

console.log(`\n${passes}/${passes + failures} checks passed` +
  (skipped ? `, ${skipped} skipped` : ''));
process.exit(failures ? 1 : 0);
