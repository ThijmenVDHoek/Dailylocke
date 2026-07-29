// ============================================================================
// storage.js — every localStorage read/write the game makes, in one place.
//
// This is step 1 of splitting the ~200 KB app.js: persistence and migrations
// first, because they are the least entangled with the DOM and the easiest to
// test in isolation. app.js keeps its `saveGame()` / `loadGame()` names and
// simply delegates here, so nothing else had to change.
//
// WHAT LIVES WHERE
//   dailylocke-run-daily   today's Daily run          (finite, dated)
//   nuzlocke-run           the Free Play run          (endless)
//   nuzlocke-profile       shinies + all-time history (outlives every run)
//   dailylocke-daily       Daily results + streak     (src/daily.js owns this)
//   nuzlocke-audio         volume sliders             (src/audio.js owns this)
//
// The run slots are SEPARATE on purpose: they used to share one key, so a good
// Free Play run blocked today's Daily and finishing a Daily destroyed the other
// run. The profile is separate for the same reason at a longer timescale --
// abandoning a run, or a save-format bump, must never wipe a shiny collection
// built up over months.
//
// EVERY access is wrapped. Safari in private mode throws on localStorage, and
// so does any browser with storage disabled; the game must degrade to "saves
// don't persist", never to a crash.
// ============================================================================
(function () {
  var SLOTS = {
    daily: 'dailylocke-run-daily',
    free: 'nuzlocke-run'              // the original key stays the Free Play slot
  };
  var LEGACY_RUN_KEY = 'nuzlocke-run-v1';
  var PROFILE_KEY = 'nuzlocke-profile';

  // SAVE_VERSION must be bumped whenever the run schema changes. Without it a
  // save written by an older build is restored into newer code and silently
  // carries missing/renamed fields -- which looks exactly like features having
  // "reverted" (blank species captions, a fainted Pokemon still in the party,
  // no section stats). Old saves are migrated where possible, dropped if not.
  var SAVE_VERSION = 3;

  // ------------------------------------------------------- SAFE STORAGE ----
  function read(key) {
    try { return localStorage.getItem(key); }
    catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { console.warn('[storage] write failed', key, e); return false; }
  }
  function drop(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }
  // Is persistence available at all? Used to warn the player once, rather than
  // letting them play for an hour and lose everything on refresh.
  function available() {
    try {
      localStorage.setItem('__dl_probe', '1');
      localStorage.removeItem('__dl_probe');
      return true;
    } catch (e) { return false; }
  }

  function keyFor(mode) { return SLOTS[mode === 'daily' ? 'daily' : 'free']; }

  // ------------------------------------------------------------- SAVES -----
  // Snapshot a live run WITHOUT writing it. `rand` is a function handle, so it
  // can't be serialised; reviveRun() rebuilds it from the seed plus the exact
  // RNG state captured here, which is what keeps catch shakes stable across a
  // refresh.
  function snapshot(run) {
    if (!run) return null;
    var c = { __v: SAVE_VERSION };
    Object.keys(run).forEach(function (k) { if (k !== 'rand') c[k] = run[k]; });
    try {
      if (run.rand && run.rand.getState) c.randState = run.rand.getState();
    } catch (e) {}
    return c;
  }

  // Persist a run to ITS OWN slot, so a Daily can never overwrite a Free Play
  // run that is still going.
  function saveRun(run) {
    if (!run || run.over) return null;
    var snap = snapshot(run);
    write(keyFor(run.mode), JSON.stringify(snap));
    return snap;
  }

  // Read one slot, migrating anything older on the way out.
  function loadRun(mode, migrate) {
    var key = keyFor(mode);
    var raw = read(key);
    var fromLegacy = false;
    // The pre-split legacy key only ever held a Free Play run.
    if (!raw && key === SLOTS.free) {
      raw = read(LEGACY_RUN_KEY);
      fromLegacy = !!raw;
    }
    if (!raw) return null;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || !data.party) return null;
    var out = migrate ? migrate(data) : data;
    // Rewrite under the new key BEFORE dropping the old one: loadRun() is
    // called more than once (title render, then the Continue click), and
    // consuming the legacy key without rewriting made the second call find
    // nothing.
    if (fromLegacy) {
      if (out) write(key, JSON.stringify(out));
      drop(LEGACY_RUN_KEY);
    }
    return out;
  }

  function clearRun(mode) {
    var key = keyFor(mode);
    drop(key);
    if (key === SLOTS.free) drop(LEGACY_RUN_KEY);
  }

  // Write a prepared snapshot straight into a slot. Used by the "archive
  // yesterday's Daily" and "carry a finished Daily into Free Play" paths,
  // which move a run BETWEEN slots rather than saving the live one.
  function putRun(mode, snap) {
    if (!snap) return false;
    return write(keyFor(mode), JSON.stringify(snap));
  }

  // ----------------------------------------------------------- PROFILE -----
  function blankProfile() {
    return { __v: 1, shinies: [], history: [], totalRuns: 0, bestBattles: 0,
             bestSection: 0, totalCaught: 0, totalKOs: 0, avatar: 'red', theme: 'default' };
  }

  function loadProfile() {
    var profile;
    try {
      var raw = read(PROFILE_KEY);
      profile = raw ? JSON.parse(raw) : blankProfile();
    } catch (e) { profile = blankProfile(); }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) profile = blankProfile();
    // Tolerate a partially-written or hand-edited profile: fill every missing
    // field rather than letting one `undefined` propagate into the UI.
    var d = blankProfile();
    Object.keys(d).forEach(function (k) { if (profile[k] == null) profile[k] = d[k]; });
    if (!Array.isArray(profile.shinies)) profile.shinies = [];
    if (!Array.isArray(profile.history)) profile.history = [];
    return profile;
  }

  function saveProfile(profile) {
    if (!profile) return false;
    return write(PROFILE_KEY, JSON.stringify(profile));
  }

  // -------------------------------------------------------- MIGRATIONS -----
  // Bring any older save up to the current schema. Returns null when the save
  // cannot be salvaged (nothing left alive), which callers treat as "no save".
  //
  // `deps` supplies the few game helpers migration needs, so this module has no
  // dependency on Core/Nuz and can be unit-tested on its own.
  function migrate(d, deps) {
    if (!d) return null;
    deps = deps || {};
    var cleanName = deps.cleanName || function (x) { return String(x); };
    var v = d.__v || 1;

    // v1 -> v2: species split out from name; sectionStats / catchMissed added;
    // fainted Pokemon were not always buried.
    if (v < 2) {
      (d.party || []).forEach(function (m) {
        if (!m.species) m.species = cleanName(m.id);
        if (!m.name) m.name = m.species;
        if (m.pp == null) m.pp = {};
      });
      // A fainted Pokemon must never survive in the party.
      d.graveyard = d.graveyard || [];
      for (var i = (d.party || []).length - 1; i >= 0; i--) {
        var mon = d.party[i];
        if (!mon || mon.hpPct > 0) continue;
        d.graveyard.push({ name: mon.name, id: mon.id, section: d.section || 1,
                           killedBy: 'a previous battle',
                           damage: Math.round((d.damageDealt || {})[mon.uid] || 0) });
        d.party.splice(i, 1);
      }
      if (d.catchMissed === undefined) d.catchMissed = false;
      if (d.lastCaughtName === undefined) d.lastCaughtName = null;
      if (!d.sectionStats) {
        d.sectionStats = { money: 0, won: 0, caught: null, lost: [],
                           damage: 0, kos: 0, startedAt: d.section || 1 };
      }
      d.__v = 2;
    }

    // v2 -> v3: runs gained a MODE. Every pre-split save lived in the single
    // slot and was therefore a Free Play run, even if it was started from the
    // Daily button -- there is no way to know which day it belonged to, and
    // guessing would corrupt a streak. Free Play is the safe, lossless answer.
    if (v < 3) {
      if (!d.mode) d.mode = 'free';
      if (d.dailyDate === undefined) d.dailyDate = null;
      if (!Array.isArray(d.sectionMarks)) d.sectionMarks = [];
      if (d.maxSections === undefined) d.maxSections = 0;
      d.__v = 3;
    }

    // A save with nothing left alive is not resumable.
    if (!d.party || !d.party.length) return null;
    return d;
  }

  // Schema check for DECODED save data (a pasted code, a ?save= link). Returns
  // null when usable, otherwise a human-readable reason -- every invalid,
  // corrupt or foreign code fails here instead of crashing the run.
  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return 'That does not look like a save from this game.';
    }
    // Tolerate numeric-string seeds from hand-edited codes.
    if (typeof data.seed === 'string' && data.seed.trim() !== '' && isFinite(Number(data.seed))) {
      data.seed = Number(data.seed);
    }
    if (typeof data.seed !== 'number' || !isFinite(data.seed)) {
      return 'The save data is missing required run information.';
    }
    if ((data.__v || 1) > SAVE_VERSION) {
      return 'This save was made with a newer version of the game and cannot be loaded here.';
    }
    if (!Array.isArray(data.party)) return 'The save data has no party information.';
    if (!data.party.length) return 'That run has no Pokemon left to continue with.';
    for (var i = 0; i < data.party.length; i++) {
      var m = data.party[i];
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) {
        return 'The save data has a corrupted party member.';
      }
    }
    return null;
  }

  window.Storage = {
    SLOTS: SLOTS, SAVE_VERSION: SAVE_VERSION, PROFILE_KEY: PROFILE_KEY,
    available: available, keyFor: keyFor,
    snapshot: snapshot, saveRun: saveRun, loadRun: loadRun,
    clearRun: clearRun, putRun: putRun,
    blankProfile: blankProfile, loadProfile: loadProfile, saveProfile: saveProfile,
    migrate: migrate, validate: validate,
    // low-level, for the few callers that own their own key
    read: read, write: write, drop: drop
  };
})();
