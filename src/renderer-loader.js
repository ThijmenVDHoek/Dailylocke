// ============================================================================
// renderer-loader.js — optional post-paint 3D upgrade.
//
// The title screen is usable before this runs: the title markup/CSS paints
// first, then Three + BattleUI are fetched and attached to the showcase. A
// battle started during the upgrade simply awaits `RendererReady.ready`.
// ============================================================================
(function () {
  var loaded = false;
  var started = false;
  var resolveReady, rejectReady;
  var ready = new Promise(function (resolve, reject) {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function start() {
    if (started) return ready;
    started = true;
    window.RendererReady.started = true;
    loadScript('vendor/three.min.js')
      .then(function () { return loadScript('vendor/battle-ui.js'); })
      .then(function () { return loadScript('src/ui-patch.js'); })
      .then(function () {
        loaded = true;
        window.RendererReady.loaded = true;
        resolveReady(true);
      })
      .catch(function (err) {
        window.RendererReady.error = err;
        rejectReady(err);
      });
    return ready;
  }

  window.RendererReady = {
    loaded: loaded,
    started: started,
    error: null,
    ready: ready,
    start: start
  };

  // Two frames gives the static title a paint opportunity before the 608 KB
  // Three.js asset enters the critical network/parse path.
  function afterFirstPaint() {
    if (window.requestAnimationFrame) {
      requestAnimationFrame(function () {
        requestAnimationFrame(start);
      });
    } else {
      setTimeout(start, 80);
    }
  }
  afterFirstPaint();
}());
