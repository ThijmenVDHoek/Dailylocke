// ============================================================================
// pwa.js — installability: service worker + the title-screen Install button.
//
// Everything about "Dailylocke as an installed app" lives here:
//
//   * registers the service worker after first paint, so downloading the
//     offline cache never competes with the game's critical render;
//   * captures Chrome/Edge/Android's `beforeinstallprompt` and suppresses the
//     browser's own mini-infobar, re-offering it as a floating pill on the
//     title screen -- the install lands when the player asks for it, not while
//     they are mid-run;
//   * on platforms that never fire that event but CAN still install (iOS /
//     iPadOS, and Safari 17+ on macOS) the same pill opens a short how-to
//     sheet instead, because there is no API to call there;
//   * disappears for good once the app is installed, and snoozes for two weeks
//     when the player taps the little x.
//
// Every failure mode degrades to "no button": an unsupported browser, a
// blocked service worker, or a private-mode localStorage all leave the rest of
// the game untouched.
// ============================================================================
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // Same `nuzlocke-` namespace as the run, profile and audio keys.
  var SNOOZE_KEY = 'nuzlocke-install';
  var SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;   // two weeks

  var deferredPrompt = null;   // the captured beforeinstallprompt event
  var mode = '';               // '' = nothing to offer | 'prompt' | 'manual'
  var installedFlag = false;   // set by the appinstalled event
  var snoozeUntil = 0;         // epoch ms; mirrored in localStorage

  var ua = (navigator && navigator.userAgent) || '';

  // ------------------------------------------------------------ PLATFORM ---
  // iPadOS reports itself as a Mac; the touch-point count is the usual tell.
  // navigator.platform is deprecated (empty in cross-origin iframes / hardened
  // browsers), so fall back to the UA check on the main iPadOS tell.
  function isIOS() {
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
      (/MacIntel/.test(ua) && navigator.maxTouchPoints > 1);
  }
  // Safari only, and only the desktop build: every other engine on macOS puts
  // its own token (Chrome, Chromium, Edg, Firefox) in the UA.
  function isMacSafari() {
    if (isIOS() || !/Macintosh|Mac OS X/.test(ua)) return false;
    if (!/Safari/.test(ua) || /Chrome|Chromium|Android|CriOS|FxiOS|Edg|OPR/.test(ua)) return false;
    // "Add to Dock" arrived in Safari 17 (Sonoma). Older versions cannot
    // install at all, so a how-to sheet would just be a lie.
    var v = ua.match(/Version\/(\d+)/);
    return !!v && parseInt(v[1], 10) >= 17;
  }
  function canInstallManually() { return isIOS() || isMacSafari(); }

  // ----------------------------------------------------------- INSTALLED ---
  // Already running as an app? Then there is nothing to offer. Covers the
  // standard display-mode media queries, the iOS-only navigator flag, and the
  // Android TWA referrer.
  function isStandalone() {
    try {
      if (navigator.standalone === true) return true;
      if (window.matchMedia) {
        var modes = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];
        for (var i = 0; i < modes.length; i++) {
          var mq = window.matchMedia('(display-mode: ' + modes[i] + ')');
          if (mq && mq.matches) return true;
        }
      }
      if (document.referrer && document.referrer.indexOf('android-app://') === 0) return true;
    } catch (e) {}
    return false;
  }
  function installed() { return installedFlag || isStandalone(); }

  // -------------------------------------------------------------- SNOOZE ---
  // Kept in memory as well as in storage so the button still behaves during a
  // session where localStorage throws (Safari private browsing).
  function readSnooze() {
    try {
      var raw = localStorage.getItem(SNOOZE_KEY);
      if (!raw) return 0;
      var o = JSON.parse(raw);
      return (o && typeof o.until === 'number') ? o.until : 0;
    } catch (e) { return 0; }
  }
  function writeSnooze(until) {
    try {
      if (until) localStorage.setItem(SNOOZE_KEY, JSON.stringify({ __v: 1, until: until }));
      else localStorage.removeItem(SNOOZE_KEY);
    } catch (e) {}
  }
  function snoozed() { return snoozeUntil > Date.now(); }

  // ----------------------------------------------------------- VISIBILITY ---
  function sync() {
    var dock = $('installDock');
    if (!dock) return;
    dock.hidden = !(mode && !installed() && !snoozed());
  }

  function toast(msg) {
    // app.js owns the toast; it boots after this module, so look it up late.
    if (window.Game && window.Game.toast) window.Game.toast(msg);
  }

  // ------------------------------------------------------------- INSTALL ---
  function install() {
    if (mode === 'prompt' && deferredPrompt) {
      var evt = deferredPrompt;
      // A captured prompt is single-use. Drop it and hide the pill either
      // way; Chrome fires a fresh event on the next visit if the player
      // backs out of its dialog.
      deferredPrompt = null;
      mode = '';
      sync();
      try {
        evt.prompt();
        if (evt.userChoice && evt.userChoice.then) {
          evt.userChoice.then(function (res) {
            if (!res || res.outcome !== 'accepted') return;
            installedFlag = true;
            writeSnooze(0);
            sync();
          }).catch(function () {});
        }
      } catch (e) { /* a stale event just does nothing */ }
      return;
    }
    if (mode === 'manual') openSheet();
  }

  function dismiss() {
    snoozeUntil = Date.now() + SNOOZE_MS;
    writeSnooze(snoozeUntil);
    sync();
  }

  // -------------------------------------------------------- HOW-TO SHEET ---
  // iOS and Safari expose no install API at all, so the pill explains the two
  // taps the player has to make themselves.
  function stepsFor() {
    if (isIOS()) {
      return ['Tap the Share button in the browser bar.',
              'Scroll down and choose "Add to Home Screen".',
              'Tap "Add" \u2014 Dailylocke lands on your Home Screen.'];
    }
    return ['Open the Share menu in Safari\u2019s toolbar.',
            'Choose "Add to Dock".',
            'Confirm \u2014 Dailylocke gets its own window.'];
  }

  function openSheet() {
    var box = $('installSteps'), sheet = $('screenInstall');
    if (!box || !sheet) return;
    box.textContent = '';
    stepsFor().forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;          // never HTML: this is plain copy
      box.appendChild(li);
    });
    // Dialog semantics, focus trapping, Escape and focus restore all come
    // from the shared modal controller (src/modal.js).
    if (window.Modal) window.Modal.open('screenInstall');
    else sheet.hidden = false;
  }
  function closeSheet() {
    if (window.Modal) { window.Modal.close('screenInstall'); return; }
    var s = $('screenInstall'); if (s) s.hidden = true;
  }

  // ---------------------------------------------------------------- BOOT ---
  function bind() {
    var btn = $('btnInstall'), x = $('btnInstallHide');
    if (btn) btn.addEventListener('click', install);
    if (x) x.addEventListener('click', dismiss);
    var close = $('btnInstallClose'), sheet = $('screenInstall');
    if (close) close.addEventListener('click', closeSheet);
    // Backdrop + Escape are the modal controller's job when it is present.
    if (!window.Modal) {
      if (sheet) sheet.addEventListener('click', function (e) {
        if (e.target === sheet) closeSheet();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sheet && !sheet.hidden) closeSheet();
      });
    }
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    // Suppress the browser's own banner; ours lives on the title screen.
    if (e.preventDefault) e.preventDefault();
    deferredPrompt = e;
    mode = 'prompt';                 // upgrades a 'manual' guess if it was set
    sync();
  });

  window.addEventListener('appinstalled', function () {
    installedFlag = true;
    deferredPrompt = null;
    mode = '';
    // A snooze is meaningless once installed -- clear the in-memory copy too,
    // or `snoozed()` keeps reporting true for the rest of the session.
    snoozeUntil = 0;
    writeSnooze(0);
    sync();
    closeSheet();
    toast('Installed! Dailylocke now opens from your home screen.');
  });

  // The display mode can flip mid-session (installed in another tab, or the
  // player launches the installed copy), so track it live where supported.
  try {
    if (window.matchMedia) {
      var mq = window.matchMedia('(display-mode: standalone)');
      var onChange = function () { sync(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (e) {}

  // ------------------------------------------------------ SERVICE WORKER ---
  // Registered on load so the offline cache never competes with the first
  // render. The path is RELATIVE on purpose: this ships to a GitHub Pages
  // project site (/Dailylocke/), where '/sw.js' is a 404 and an absolute
  // scope would be rejected outright. Service workers also need a secure
  // context (HTTPS, or localhost while developing).
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      // The game stays fully playable if registration is blocked (private
      // browsing, an unsupported browser, a transient network failure) --
      // only offline support and the install prompt are lost.
      console.warn('[pwa] service worker registration failed', err);
    });
  }
  window.addEventListener('load', registerServiceWorker, { once: true });

  function init() {
    snoozeUntil = readSnooze();
    // Guess before any event arrives: on iOS/Safari no event is ever coming.
    if (!mode && canInstallManually()) mode = 'manual';
    bind();
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PWA = {
    install: install,
    dismiss: dismiss,
    refresh: sync,
    openSheet: openSheet,
    closeSheet: closeSheet,
    get mode() { return mode; },
    get installed() { return installed(); },
    get snoozed() { return snoozed(); },
    SNOOZE_KEY: SNOOZE_KEY,
    SNOOZE_MS: SNOOZE_MS
  };
})();
