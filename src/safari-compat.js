(function () {
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  // iOS Safari's URL bar changes visualViewport without always firing the
  // classic resize event. Forward a resize so the Three.js battle canvas and
  // touch HUD stay aligned.
  function syncViewport() { window.dispatchEvent(new Event('resize')); }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport, {passive:true});
    window.visualViewport.addEventListener('scroll', syncViewport, {passive:true});
  }
  window.addEventListener('pageshow', function (e) { if (e.persisted) syncViewport(); });
  // A non-passive document touch listener is deliberately avoided: it breaks
  // normal button clicks in Safari. Native click synthesis remains reliable.
})();
