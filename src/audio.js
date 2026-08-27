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
    audio._isMusic = true;
    audio.loop = true;
    // `none` until a battle actually needs it: these are 1-3 MB files and
    // eagerly fetching one competes with the sim bundle and first sprites.
    audio.preload = 'none';
    audio.volume = gain(settings.music);
    return audio;
  }

  // One-shot elements (cries, previews) come from a fixed pool. The pool is
  // pre-primed inside the first gesture so iOS lets them play even when the
  // cry is requested later, outside a gesture (battle cries fire after an
  // async battle-start, not on the tap itself).
  function makeSfxEl() {
    var a = new Audio();
    a.preload = 'auto';
    a._isMusic = false;
    a._busy = false;
    return a;
  }
  function freeSfxEl() {
    for (var i = 0; i < sfxPool.length; i++) {
      if (!sfxPool[i]._busy) return sfxPool[i];
    }
    // Rare case: every pooled element is mid-cry. Grow the pool rather than
    // blocking the sound.
    var a = makeSfxEl();
    sfxPool.push(a);
    primeElement(a);
    return a;
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

  // iOS / iPadOS (which Chrome and all other browsers on an iPad use under the
  // hood -- there is no independent iOS Chrome engine) will only start a
  // *media element* from inside a user gesture. The synthesized typewriter
  // blip uses the Web Audio API and so survives this, which is why Oak's
  // text ticks played while the battle music (started after an `await`, hence
  // OUTSIDE the tap that entered the battle) and every freshly-created cry
  // element (also outside a gesture) stayed silent.
  //
  // The fix mirrors what every mobile-web-audio library does: on the first
  // gesture, "prime" the media stack by actually playing a tiny silent clip on
  // both the shared music element and a small pool of one-shot elements. On
  // iOS a media element that has played once in a gesture is then free to
  // have its src swapped and be played again programmatically.
  var SILENCE_URL = new URL('../assets/audio/silence.wav', (document.currentScript && document.currentScript.src) || window.location.href).href;
  var PRIME_VOLUME = 0.001;   // inaudible on any platform that ignores unlock
  var sfxPool = [];

  function safePlay(a) {
    try {
      var p = a.play();
      // jsdom returns undefined here rather than a promise.
      if (p && typeof p.then === 'function') p.catch(function () { /* blocked; a later gesture retries */ });
    } catch (e) { /* ignore */ }
  }

  // Play the silent clip on one element, then pause and reset it. Called from
  // within the unlock gesture handler so the play() is gesture-attributed.
  function primeElement(a) {
    if (!a || a._primed) return;
    try {
      var restoreVolume = a.volume;
      var restoreLoop = a.loop;
      a.src = SILENCE_URL;
      a.loop = false;
      a.volume = PRIME_VOLUME;
      a.addEventListener('playing', function once() {
        a.removeEventListener('playing', once);
        a._primed = true;
        try { a.pause(); } catch (e) {}
        try { a.currentTime = 0; } catch (e) {}
        a.removeAttribute('src');
        try { a.load(); } catch (e) {}
        a.volume = restoreVolume;
        a.loop = restoreLoop;
      }, { once: true });
      safePlay(a);
    } catch (e) { /* ignored: a later gesture tries again */ }
  }

  function primeAudio() {
    primeElement(el());
    if (!sfxPool.length) {
      for (var i = 0; i < 4; i++) sfxPool.push(makeSfxEl());
    }
    sfxPool.forEach(primeElement);
  }

  // If music was requested but never started (e.g. the battle began after an
  // await, so play() ran outside the gesture), any later gesture is another
  // chance to start it. This listener is permanent (unlike the one-time
  // unlock) specifically so an autoplay rejection during battle self-heals
  // the moment the player next taps.
  function kickOnGesture() {
    if (blipCtx && blipCtx.state === 'suspended') { try { blipCtx.resume(); } catch (e) {} }
    if (!unlocked) return;
    primeAudio();
    if (wantKind && audio && audio.paused && gain(settings.music) > 0) {
      audio.loop = true;
      safePlay(audio);
    }
  }
  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, kickOnGesture, { passive: true });
  });

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
    a.loop = true;
    if (currentTrack !== track) {
      currentTrack = track;
      lastTrack = track;
      a.src = BASE + track + '.mp3';
      // A preload="none" element that only gets its src after the first
      // paint needs an explicit load() on some iPad WebKits, otherwise play()
      // can settle back to paused without an error.
      try { a.load(); } catch (e) {}
    }
    a.volume = gain(settings.music);
    try { a.currentTime = 0; } catch (e) { /* not seekable yet */ }
    if (gain(settings.music) > 0) safePlay(a);
    // Belt and braces: if play() was rejected (autoplay policy), the first
    // subsequent gesture retries it via kickOnGesture.
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

  // First user gesture: browsers only allow audio to begin from one. This
  // both resumes the Web Audio context (blips) and primes the media-element
  // stack (music + cries) so playback started by later, non-gesture code is
  // permitted on iOS / iPadOS.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    primeAudio();
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
  // Playback uses a primed pool element so iOS/iPadOS permits it even when
  // this is called outside a user gesture (e.g. battle cries that fire after
  // the async battle-start). The returned element exposes `volume` for
  // callers (BattleUI) that used to own their own Audio.
  function playSfx(urls, base) {
    var g = gain(settings.sfx) * (base == null ? 1 : base);
    var list = [].concat(urls || []);
    if (!list.length) return null;
    var a = freeSfxEl();
    a._busy = true;
    if (g > 0) a.volume = clamp01(g);
    var i = 0;
    function release() {
      a._busy = false;
      try { a.removeAttribute('src'); } catch (e) {}
      try { a.load(); } catch (e) {}
    }
    a.onerror = function () {
      i++;
      if (i < list.length) { a.src = list[i]; try { a.load(); } catch (e) {} safePlay(a); }
      else release();
    };
    a.onended = release;
    try { a.removeAttribute('loop'); } catch (e) {}
    a.src = list[0];
    try { a.load(); } catch (e) {}
    if (g > 0) safePlay(a);
    else release();
    return a;
  }

  // --------------------------------------------------------------- blip ---
  // The typewriter "text sound": a tiny synthesized click, Animal Crossing
  // style — soft, short, and slightly pitched per character. Made in-house
  // with Web Audio so it never depends on a network fetch and can't be
  // mistaken for a Pokemon cry.
  var blipCtx = null;

  function synthBlip() {
    var g = gain(settings.sfx) * 0.10;
    if (g <= 0) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!blipCtx) blipCtx = new AC();
      var ctx = blipCtx;
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gN = ctx.createGain();
      // Animal Crossing blips wander a little in pitch; a triangle wave keeps
      // them soft rather than beepy. Frequencies are kept out of the low bass
      // so the ticks never rumble on phone speakers.
      var freq = 640 + Math.random() * 280;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      gN.gain.setValueAtTime(0.0001, t0);
      gN.gain.exponentialRampToValueAtTime(g, t0 + 0.008);
      gN.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
      osc.connect(gN); gN.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.085);
    } catch (e) { /* audio blocked or unsupported: text reveal still works */ }
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
    synthBlip: synthBlip,
    unlock: unlock,
    // Pool access for the battle UI's cry queue. Cry playback lives in the
    // vendor battle code but must go through gesture-primed elements on iOS;
    // these let it borrow and return a pooled element. On take the element is
    // marked busy and stripped of any previous one-shot handlers; on release
    // it is paused, detached from its cry and made available again.
    _takeSfx: function () {
      var a = freeSfxEl();
      if (a) { a._busy = true; a.onended = null; a.onerror = null; }
      return a;
    },
    _releaseSfx: function (a) {
      if (!a) return;
      try { a.pause(); } catch (e) {}
      a._busy = false;
      a.onended = null; a.onerror = null;
      try { a.removeAttribute('src'); } catch (e) {}
      try { a.load(); } catch (e) {}
    },
    // Set up the URL-fallback chain on a borrowed element and start it.
    // Returns false when the very first play() was rejected (so the caller
    // can fall back to another element/implementation).
    _playOn: function (a, urlList) {
      if (!a || !urlList) return false;
      var list = [].concat(urlList);
      var i = 0;
      a.onerror = function () {
        i++;
        if (i < list.length) { a.src = list[i]; try { a.load(); } catch (e) {} safePlay(a); }
      };
      try { a.removeAttribute('loop'); } catch (e) {}
      a.src = list[0];
      try { a.load(); } catch (e) {}
      var ok = true;
      try {
        var p = a.play();
        if (p && typeof p.then === 'function') {
          p.catch(function () { ok = false; });
        }
      } catch (e) { ok = false; }
      return ok;
    },
    get currentTrack() { return currentTrack; }
  };
})();
