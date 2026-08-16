// ============================================================================
// champions-loader.js — lazy loader for the optional Champions learnset data.
// The normal Showdown learnsets remain the source of truth; this supplement is
// fetched only when Core.legalMoves() first needs a move pool.
// ============================================================================
(function () {
  var pending = null;

  function ready() {
    if (window.ChampionsLearnsets) return Promise.resolve(window.ChampionsLearnsets);
    if (pending) return pending;
    pending = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'src/champions-learnsets.js';
      script.async = true;
      script.onload = function () {
        if (window.ChampionsLearnsets) resolve(window.ChampionsLearnsets);
        else reject(new Error('Champions learnset chunk loaded empty'));
      };
      script.onerror = function () {
        pending = null;
        reject(new Error('Failed to load Champions learnsets'));
      };
      document.head.appendChild(script);
    });
    return pending;
  }

  window.ChampionsLearnsetsReady = ready;
}());
