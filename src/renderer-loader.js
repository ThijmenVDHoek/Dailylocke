// ============================================================================
// renderer-loader.js — optional post-paint 3D upgrade.
//
// The title screen is usable before this runs: the title markup/CSS paints
// first, then Three + BattleUI are fetched and attached to the showcase. A
// battle started during the upgrade simply awaits `RendererReady.ready`.
//
// If the 3D scripts fail to load (transient network / offline), the game
// falls back gracefully to flat mode — the battle is fully playable without
// WebGL.
// ============================================================================
(function () {
  var loaded = false;
  var started = false;
  var resolveReady, rejectReady;
  var ready = new Promise(function (resolve, reject) {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function loadScript(src, retries) {
    retries = retries || 1;
    return new Promise(function (resolve, reject) {
      var attempt = function (remaining) {
        var script = document.createElement('script');
        script.src = src;
        script.async = true;
        // Preload the 3D bundles at High priority so the title scene is
        // interactive as soon as possible.
        try { if ('fetchPriority' in script) script.fetchPriority = 'high'; } catch (e) {}
        script.onload = resolve;
        script.onerror = function () {
          if (remaining > 0) {
            console.warn('[renderer] retrying ' + src + ' (' + remaining + ' left)');
            // Remove the failed script element
            if (script.parentNode) script.parentNode.removeChild(script);
            setTimeout(function () { attempt(remaining - 1); }, 1500);
          } else {
            reject(new Error('Failed to load ' + src));
          }
        };
        document.head.appendChild(script);
      };
      attempt(retries);
    });
  }

  function start() {
    if (started) return ready;
    started = true;
    window.RendererReady.started = true;
    loadScript('vendor/three.min.js', 1)
      .then(function () { return loadScript('vendor/battle-ui.js', 1); })
      .then(function () { return loadScript('src/ui-patch.js', 1); })
      .then(function () {
        loaded = true;
        window.RendererReady.loaded = true;
        resolveReady(true);
      })
      .catch(function (err) {
        window.RendererReady.error = err;
        console.warn('[renderer] 3D bundle unavailable; game will use flat mode', err);
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
