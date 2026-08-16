// ============================================================================
// app-loader.js — load the large game controller after the first static paint.
// The HTML/title sheet can render while the controller parses; this keeps the
// 369 KB app.js out of the first-paint critical path without changing globals.
// ============================================================================
(function () {
  var started = false;
  var resolveReady;
  var ready = new Promise(function (resolve) { resolveReady = resolve; });

  function start() {
    if (started) return ready;
    started = true;
    window.AppReady.started = true;
    var script = document.createElement('script');
    script.src = 'src/app.js';
    script.async = true;
    script.onload = function () { window.AppReady.loaded = true; resolveReady(true); };
    script.onerror = function () {
      var err = new Error('Failed to load the game controller');
      window.AppReady.error = err;
      if (window.__dailylockeShowFatal) {
        window.__dailylockeShowFatal('The game could not start', 'The game controller failed to load. Reload the page to try again.', err.message);
      }
      resolveReady(false);
    };
    document.head.appendChild(script);
    return ready;
  }

  window.AppReady = { started: false, loaded: false, error: null, ready: ready, start: start };
  if (window.requestAnimationFrame) {
    requestAnimationFrame(function () { requestAnimationFrame(start); });
  } else {
    setTimeout(start, 80);
  }
}());
