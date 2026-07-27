// ============================================================================
// audio.js — one owner for every sound the game makes.
//
// WHY THIS EXISTS
//   Music and cries used to set `.volume` from hardcoded constants scattered
//   across app.js (0.5), battle-ui.js (0.35) and the music IIFE (1.0). There
//   was no way to turn any of it down, and the music played at full blast on
//   every screen — including the title and the mart.
//
// WHAT IT GUARANTEES
//   * Two persisted sliders: music and SFX, 0..1, saved outside the run save
//     so abandoning a run never resets them.
//   * Music plays ONLY during a battle. Leaving the battle screen fades it
//     out; the next battle starts a fresh, randomly chosen track.
//   * Wild battles and trainer battles draw from different pools, so the
//     music tells you what kind of fight you walked into before the HUD does.
//
// VOLUME CURVE
//   Sliders are perceptual, not linear: gain = slider^2. Human loudness is
//   roughly logarithmic, so a linear slider spends most of its travel in the
//   "far too loud" range and gives you no fine control down where you
//   actually want background music to sit.
// ============================================================================
(function () {
  var KEY = 'nuzlocke-audio';

  // Deliberately quiet. The old music volume was 1.0 in battle / 0.5 outside,
  // which drowned out the cries and everything else.
  var DEFAULTS = { music: 0.35, sfx: 0.7, __v: 1 };

  var BASE = 'https://play.pokemonshowdown.com/audio/';

  // Showdown ships no wild-encounter theme — every track is a trainer or
  // rival battle. Rival/villain themes are the shorter, scrappier ones, so
  // they stand in for wild fights; the heavier trainer themes are saved for
  // trainers, and the two "final" tracks are held back for boss trainers.
  var TRACKS = {
    wild: ['bw-rival', 'bw2-rival', 'dpp-rival', 'oras-rival', 'sm-rival',
           'xy-rival', 'colosseum-miror-b', 'xd-miror-b'],
    trainer: ['bw-trainer', 'bw-subway-trainer', 'bw2-homika-dogars',
              'dpp-trainer', 'hgss-johto-trainer', 'hgss-kanto-trainer',
              'oras-trainer', 'sm-trainer', 'xy-trainer'],
    boss: ['spl-elite4', 'bw2-kanto-gym-leader']
  };

  // ------------------------------------------------------------ settings ---
  var settings = load();

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }
  function load() {
    var s = { music: DEFAULTS.music, sfx: DEFAULTS.sfx };
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.music != null) s.music = clamp01(p.music);
          if (p.sfx != null) s.sfx = clamp01(p.sfx);
        }
      }
    } catch (e) { /* private mode / corrupt value: fall back to defaults */ }
    return s;
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ __v: 1, music: settings.music, sfx: settings.sfx }));
    } catch (e) { /* not worth interrupting the game over */ }
  }

  // slider position -> actual gain
  function gain(v) { return clamp01(v) * clamp01(v); }

  // ---------------------------------------------------------------- music --
  var audio = null;
  var unlocked = false;      // has the browser let us start audio yet?
  var wantKind = null;       // the battle we're supposed to be scoring, if any
  var currentTrack = null;
  var lastTrack = null;
  var fadeTimer = null;

  function el() {
    if (audio) return audio;
    audio = new Audio();
    audio.loop = true;
    // `none` until a battle actually needs it: these are 1-3 MB files and
    // eagerly fetching one competes with the sim bundle and first sprites.
    audio.preload = 'none';
    audio.volume = gain(settings.music);
    return audio;
  }

  function pickTrack(kind) {
    var pool = TRACKS[kind] || TRACKS.wild;
    if (pool.length > 1 && lastTrack) {
      // Never repeat the previous track back-to-back; with 8-9 per pool the
      // odds of a repeat are otherwise noticeable over a long run.
      var fresh = pool.filter(function (t) { return t !== lastTrack; });
      if (fresh.length) pool = fresh;
    }
    // Math.random on purpose: the run's seeded RNG must stay reserved for
    // gameplay, or picking a song would desync every daily run.
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function stopFade() {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  }

  function safePlay(a) {
    try {
      var p = a.play();
      // jsdom returns undefined here rather than a promise.
      if (p && typeof p.then === 'function') p.catch(function () { /* blocked; a later gesture retries */ });
    } catch (e) { /* ignore */ }
  }

  // Start (or switch to) the music for a battle. Safe to call before the
  // browser has unlocked audio: the choice is remembered and played on the
  // first gesture.
  function startBattle(kind) {
    if (kind !== 'wild' && kind !== 'trainer' && kind !== 'boss') kind = 'wild';
    wantKind = kind;
    if (!unlocked) return;
    stopFade();

    var track = pickTrack(kind);
    var a = el();
    if (currentTrack !== track) {
      currentTrack = track;
      lastTrack = track;
      a.src = BASE + track + '.mp3';
    }
    a.volume = gain(settings.music);
    try { a.currentTime = 0; } catch (e) { /* not seekable yet */ }
    if (gain(settings.music) > 0) safePlay(a);
  }

  // Leave the battle screen: fade out over ~450ms, then park the track at the
  // start so the next battle begins cleanly.
  function stop(immediate) {
    wantKind = null;
    stopFade();
    if (!audio || audio.paused) { currentTrack = null; return; }

    var a = audio;
    function park() {
      a.pause();
      try { a.currentTime = 0; } catch (e) {}
      currentTrack = null;
    }
    if (immediate) return park();

    var steps = 9, from = a.volume, i = 0;
    fadeTimer = setInterval(function () {
      i++;
      a.volume = Math.max(0, from * (1 - i / steps));
      if (i >= steps) { stopFade(); park(); a.volume = gain(settings.music); }
    }, 50);
  }

  // First user gesture: browsers only allow audio to begin from one.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (wantKind) startBattle(wantKind);
  }
  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, unlock, { once: true, passive: true });
  });

  // Don't keep playing into a backgrounded tab.
  document.addEventListener('visibilitychange', function () {
    if (!audio) return;
    if (document.hidden) { stopFade(); audio.pause(); }
    else if (wantKind && gain(settings.music) > 0) safePlay(audio);
  });

  // ------------------------------------------------------------------ sfx --
  // Cries and one-shots route through here so the slider actually governs
  // them. `base` scales one effect relative to the others (default 1).
  function playSfx(urls, base) {
    var g = gain(settings.sfx) * (base == null ? 1 : base);
    if (g <= 0) return null;
    var list = [].concat(urls || []);
    if (!list.length) return null;
    var a = new Audio();
    a.volume = clamp01(g);
    var i = 0;
    a.addEventListener('error', function () {
      i++;
      if (i < list.length) { a.src = list[i]; a.load(); safePlay(a); }
    });
    a.src = list[0];
    safePlay(a);
    return a;
  }

  window.GameAudio = {
    DEFAULTS: DEFAULTS,
    TRACKS: TRACKS,

    // settings
    getMusic: function () { return settings.music; },
    getSfx: function () { return settings.sfx; },
    setMusic: function (v) {
      settings.music = clamp01(v);
      save();
      if (audio) {
        stopFade();
        audio.volume = gain(settings.music);
        // Dragging up from silence should bring the battle track back.
        if (wantKind && unlocked && settings.music > 0 && audio.paused) safePlay(audio);
        else if (settings.music === 0) audio.pause();
      }
      return settings.music;
    },
    setSfx: function (v) { settings.sfx = clamp01(v); save(); return settings.sfx; },

    // resolved gains, for callers that set `.volume` themselves
    musicVolume: function () { return gain(settings.music); },
    sfxVolume: function (base) { return gain(settings.sfx) * (base == null ? 1 : base); },

    // playback
    startBattle: startBattle,
    stop: stop,
    playSfx: playSfx,
    unlock: unlock,
    get currentTrack() { return currentTrack; }
  };
})();
