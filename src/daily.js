// ============================================================================
// daily.js — the Daily challenge: a finite, dated, scoreable run.
//
// WHY THIS EXISTS
//   The Daily used to be an ordinary endless run that happened to use a dated
//   seed, and it shared the single save slot with everything else. A good run
//   therefore LOCKED THE PLAYER OUT of tomorrow's Daily unless they abandoned
//   it. That is the opposite of what a daily should do.
//
// THE SHAPE NOW
//   * Daily and Free Play have SEPARATE save slots (see app.js SLOTS).
//   * A Daily is 5 sections (20 battles). Clearing section 5 COMPLETES it.
//   * A cleared Daily is scored, recorded and shareable, and its surviving
//     team can continue in Free Play. A wipe always ends with no continuation.
//   * Yesterday's unfinished Daily is never silently destroyed: it is offered
//     as an archived Free Play run.
//
// STREAKS
//   Wordle-style but deliberately forgiving: the streak survives ONE missed
//   day. Two consecutive missed days reset it. All dates are LOCAL dates
//   (midnight in the player's own timezone), never UTC, because "today" for a
//   daily game means the player's today.
// ============================================================================
(function () {
  var C = window.Core;

  var DAILY_SECTIONS = 5;                 // finite by design
  var HISTORY_KEY = 'dailylocke-daily';   // its own key: never wiped by a run
  var HISTORY_MAX = 400;                  // ~13 months of dailies

  // ------------------------------------------------------------- DATES -----
  // Local calendar day as YYYY-MM-DD. Using the local date (not toISOString,
  // which is UTC) means a player in UTC+13 and one in UTC-11 each get their
  // own midnight rollover, which is what "daily" means to a human.
  function dayKey(d) {
    d = d || new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseKey(key) {
    var p = String(key || '').split('-');
    if (p.length !== 3) return null;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  // Whole days between two local dates, ignoring clock time and DST shifts.
  function daysBetween(aKey, bKey) {
    var a = parseKey(aKey), b = parseKey(bKey);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function shiftKey(key, delta) {
    var d = parseKey(key);
    if (!d) return null;
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  }

  // Puzzle number: day 1 is the launch date, so "Dailylocke #142" is stable
  // for everyone and never depends on when a given player installed the game.
  var EPOCH = '2026-01-01';
  function puzzleNumber(key) {
    var n = daysBetween(EPOCH, key || dayKey());
    return (n === null ? 0 : n) + 1;
  }

  // The seed every player shares for a given day.
  function seedFor(key) {
    return C.hashString('dailylocke|' + (key || dayKey()));
  }

  // ------------------------------------------------------------ STORAGE ----
  function blankStore() {
    return { __v: 1, results: {}, streak: 0, best: 0, lastPlayed: null, grace: 0 };
  }

  function load() {
    var store;
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      store = raw ? JSON.parse(raw) : blankStore();
    } catch (e) { store = blankStore(); }
    if (!store || typeof store !== 'object' || Array.isArray(store)) store = blankStore();
    var d = blankStore();
    Object.keys(d).forEach(function (k) { if (store[k] == null) store[k] = d[k]; });
    if (typeof store.results !== 'object' || Array.isArray(store.results)) store.results = {};
    return store;
  }

  function save(store) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(store)); }
    catch (e) { console.warn('[daily] save', e); }
    return store;
  }

  // Trim to the newest HISTORY_MAX days so a years-old device stays small.
  function prune(store) {
    var keys = Object.keys(store.results).sort();
    while (keys.length > HISTORY_MAX) delete store.results[keys.shift()];
    return store;
  }

  // ------------------------------------------------------------ RESULTS ----
  function resultFor(key) {
    return load().results[key || dayKey()] || null;
  }

  function isPlayed(key) { return !!resultFor(key); }

  // Record the outcome of a Daily. `outcome` is 'complete' (cleared every
  // section) or 'wipe' (party lost). Both count as PLAYED; only 'complete'
  // extends the streak, which is what makes the streak mean something.
  function record(key, data) {
    key = key || dayKey();
    var store = load();
    var existing = store.results[key];
    // A day is written once. Re-finishing an already-recorded day (import,
    // replay of an archived run) must not inflate the streak.
    if (existing) return existing;

    var entry = {
      date: key,
      n: puzzleNumber(key),
      outcome: data.outcome === 'complete' ? 'complete' : 'wipe',
      sections: Math.max(0, Math.round(data.sections || 0)),
      battles: Math.max(0, Math.round(data.battles || 0)),
      caught: Math.max(0, Math.round(data.caught || 0)),
      lost: Math.max(0, Math.round(data.lost || 0)),
      trainers: Math.max(0, Math.round(data.trainers || 0)),
      score: Math.max(0, Math.round(data.score || 0)),
      starter: data.starter || null,       // {id,name}
      mvp: data.mvp || null,               // {id,name,damage}
      marks: Array.isArray(data.marks) ? data.marks.slice(0, 40) : [],
      at: Date.now()
    };
    store.results[key] = entry;
    applyStreak(store, key, entry.outcome === 'complete');
    prune(store);
    save(store);
    return entry;
  }

  // ------------------------------------------------------------ STREAKS ----
  // Forgiving: missing a single day keeps the streak alive but burns the one
  // grace day. Missing two in a row resets to 1 (today still counts).
  function applyStreak(store, key, completed) {
    if (!completed) {
      // A wipe is an honest attempt, so it doesn't reset the streak -- but it
      // doesn't extend it either. It only updates "last played".
      store.lastPlayed = maxKey(store.lastPlayed, key);
      return store;
    }
    var last = store.lastStreakDay;
    var gap = last ? daysBetween(last, key) : null;
    if (gap === null || gap <= 0) {
      if (gap === 0) return store;         // same day, already counted
      store.streak = 1; store.grace = 1;   // first ever, or a clock rewind
    } else if (gap === 1) {
      store.streak = (store.streak || 0) + 1;
    } else if (gap === 2 && (store.grace || 0) > 0) {
      store.streak = (store.streak || 0) + 1;   // one forgiven miss
      store.grace = 0;
    } else {
      store.streak = 1; store.grace = 1;        // too long a gap
    }
    // Every clean week of play earns the grace day back.
    if (store.streak > 0 && store.streak % 7 === 0) store.grace = 1;
    store.lastStreakDay = key;
    store.lastPlayed = maxKey(store.lastPlayed, key);
    store.best = Math.max(store.best || 0, store.streak);
    return store;
  }

  function maxKey(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
  }

  // The streak as it stands TODAY. A stored streak goes stale the moment the
  // player skips days, so this recomputes against the current date instead of
  // trusting the number that was written days ago.
  function streakInfo(today) {
    today = today || dayKey();
    var store = load();
    var last = store.lastStreakDay;
    if (!last) return { streak: 0, best: store.best || 0, alive: false, graceLeft: store.grace || 0 };
    var gap = daysBetween(last, today);
    var alive = gap !== null && gap >= 0 && (gap <= 1 || (gap === 2 && (store.grace || 0) > 0));
    return {
      streak: alive ? (store.streak || 0) : 0,
      best: store.best || 0,
      alive: alive,
      lastDay: last,
      graceLeft: store.grace || 0,
      playedToday: !!store.results[today]
    };
  }

  // ----------------------------------------------------------- CALENDAR ----
  // A compact grid for the history screen: the last `days` local days, newest
  // last, each tagged with its outcome.
  function calendar(days, today) {
    days = days || 35;
    today = today || dayKey();
    var store = load();
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var key = shiftKey(today, -i);
      var r = store.results[key];
      out.push({
        date: key,
        day: Number(key.slice(8)),
        outcome: r ? r.outcome : null,
        sections: r ? r.sections : 0,
        isToday: key === today,
        future: false
      });
    }
    return out;
  }

  function stats() {
    var store = load();
    var keys = Object.keys(store.results);
    var played = keys.length, completed = 0, bestScore = 0, bestSections = 0;
    keys.forEach(function (k) {
      var r = store.results[k];
      if (r.outcome === 'complete') completed++;
      bestScore = Math.max(bestScore, r.score || 0);
      bestSections = Math.max(bestSections, r.sections || 0);
    });
    var s = streakInfo();
    return { played: played, completed: completed, bestScore: bestScore,
             bestSections: bestSections, streak: s.streak, best: s.best,
             winRate: played ? Math.round((completed / played) * 100) : 0 };
  }

  // -------------------------------------------------------- SHARE CARD -----
  // Deliberately spoiler-light: emoji squares show the SHAPE of the run
  // (which sections were clean) without naming the Pokemon that appeared.
  //
  //   Dailylocke #142
  //   Sections: 7
  //   Battles: 28
  //   Caught: 5
  //   Lost: 4
  //   MVP: Gengar
  //   🟩🟩🟥🟩
  var MARK = { clean: '\uD83D\uDFE9', hurt: '\uD83D\uDFE8', lost: '\uD83D\uDFE5', fail: '\u2B1B' };

  // One mark per section: green = nobody fell, yellow = survived but bruised,
  // red = lost a Pokemon, black = the section that ended the run.
  function markFor(section) {
    if (!section) return MARK.fail;
    if (section.ended) return MARK.fail;
    if (section.lost > 0) return MARK.lost;
    if (section.hurt) return MARK.hurt;
    return MARK.clean;
  }

  function shareText(entry, opts) {
    opts = opts || {};
    if (!entry) return '';
    var lines = [];
    lines.push('Dailylocke #' + entry.n);
    lines.push('Sections: ' + entry.sections + (entry.outcome === 'complete' ? '/' + DAILY_SECTIONS : ''));
    lines.push('Battles: ' + entry.battles);
    lines.push('Caught: ' + entry.caught);
    lines.push('Lost: ' + entry.lost);
    if (entry.mvp && entry.mvp.name) lines.push('MVP: ' + entry.mvp.name);
    if (entry.marks && entry.marks.length) lines.push(entry.marks.join(''));
    var st = streakInfo();
    if (st.streak > 1) lines.push('Streak: ' + st.streak);
    if (opts.url) lines.push(opts.url);
    return lines.join('\n');
  }

  // --------------------------------------------------------------- API -----
  window.Daily = {
    SECTIONS: DAILY_SECTIONS,
    KEY: HISTORY_KEY,
    MARK: MARK,
    dayKey: dayKey, parseKey: parseKey, shiftKey: shiftKey, daysBetween: daysBetween,
    puzzleNumber: puzzleNumber, seedFor: seedFor,
    load: load, save: save,
    resultFor: resultFor, isPlayed: isPlayed, record: record,
    streakInfo: streakInfo, calendar: calendar, stats: stats,
    markFor: markFor, shareText: shareText,
    // exposed for tests: apply a streak transition without touching storage
    _applyStreak: applyStreak
  };
})();
