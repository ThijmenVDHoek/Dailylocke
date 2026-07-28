// ============================================================================
// savecode.js — cross-device save transfer ("Save Codes").
//
// 100% client-side, no accounts, no server:
//   game state -> JSON -> LZString.compressToEncodedURIComponent() -> a short,
//   URL-safe code. The code can be copied as raw text, embedded in a share
//   link (?save=CODE) or rendered into a QR code (vendor/qrcode.js) that a
//   phone camera turns back into the link.
//
// This module owns NOTHING about the game itself; app.js provides the game
// state object and decides what to do with a decoded one (schema validation,
// migration, applying it to the run).
//
// Depends on vendor/lz-string.min.js (LZString) and, only for renderQR(),
// vendor/qrcode.js (QRCode). Both degrade gracefully when missing.
// ============================================================================
(function () {
  // The query param that shares save codes in URLs.
  var PARAM = 'save';

  // Exact alphabet produced by compressToEncodedURIComponent(). Anything
  // outside it is guaranteed not to be one of our codes, which lets the
  // import path reject junk before touching the decompressor.
  var CODE_RE = /^[A-Za-z0-9+\-$]+$/;

  var MAX_CODE_LEN = 9000;   // sanity cap for pasted blobs (paranoia, not spec)

  function lz() {
    return (typeof window.LZString !== 'undefined') ? window.LZString : null;
  }

  // False when the library failed to load (offline dev, blocked file); the UI
  // turns the feature off rather than crashing.
  function enabled() {
    var L = lz();
    return !!(L && L.compressToEncodedURIComponent && L.decompressFromEncodedURIComponent);
  }

  // ---------------------------------------------------------------- CODEC --
  // state (plain JSON-able object) -> compressed URL-safe string, or '' on
  // any failure. Never throws: the caller treats '' as "export unavailable".
  function encode(state) {
    var L = lz();
    if (!L || !state) return '';
    try {
      return L.compressToEncodedURIComponent(JSON.stringify(state)) || '';
    } catch (e) { return ''; }
  }

  // code -> parsed save state object, or null when the string is corrupted,
  // truncated, or simply not a save code. Never throws. (lz-string already
  // maps spaces back to '+', so codes that survived a URL decode are fine.)
  function decode(code) {
    var L = lz();
    if (!L || typeof code !== 'string' || !code) return null;
    code = code.trim();
    if (!code || code.length > MAX_CODE_LEN) return null;
    var json;
    try { json = L.decompressFromEncodedURIComponent(code); }
    catch (e) { return null; }
    // lz-string returns '' / null for garbage rather than raising.
    if (!json) return null;
    try { return JSON.parse(json); }
    catch (e) { return null; }   // decompressed, but not our JSON
  }

  // --------------------------------------------------------- PASTE PARSING --
  // URL query parsers decode '+' to a space (form-urlencoding), and '+' is in
  // our alphabet, so any space inside a code extracted from a URL was a '+'.
  function unspace(s) { return String(s).replace(/ /g, '+'); }

  // Accepts whatever a player drops into the import box: a full share link,
  // a link mangled by a chat app, or the bare code possibly split across
  // lines. Returns the bare code, or '' when it can't possibly be one.
  function extractCode(text) {
    if (text == null) return '';
    // Whitespace inside a pasted code (line wraps, trailing newline) is never
    // part of the alphabet, so it is always safe to remove.
    var t = String(text).replace(/\s+/g, '');
    if (!t || t.length > MAX_CODE_LEN) return '';

    // A real URL? Ask the parser for the param properly (handles #fragments).
    if (/^https?:\/\//i.test(t) && typeof URL !== 'undefined') {
      try {
        var q = unspace(new URL(t).searchParams.get(PARAM) || '');
        return CODE_RE.test(q) ? q : '';
      } catch (e) { /* fall through to the regex path */ }
    }
    // "…?save=CODE" embedded in otherwise free-form text.
    var m = /[?&]save=([A-Za-z0-9+\-$]+)/.exec(t);
    if (m) return m[1];
    // Otherwise the blob itself has to BE the code.
    return CODE_RE.test(t) ? t : '';
  }

  // -------------------------------------------------------------- LINKS ----
  // The exact URL another device can open to receive this save.
  // `${origin}${pathname}?save=${code}` — on GitHub Pages this points back at
  // this very page, which auto-imports on load.
  function buildShareUrl(code) {
    var base;
    var origin = window.location.origin;
    if (origin && origin !== 'null') {
      base = origin + window.location.pathname;
    } else {
      // file:// has no origin ('null'); fall back to the href minus query/hash.
      base = window.location.href.split(/[?#]/)[0];
    }
    return base + '?' + PARAM + '=' + code;
  }

  // The ?save= code currently in the address bar, or null. URLSearchParams
  // decodes '+' (part of our alphabet) to a space, so undo that.
  function readCodeFromUrl() {
    try {
      return unspace(new URLSearchParams(window.location.search).get(PARAM) || '') || null;
    } catch (e) {
      // ancient browser, manual scan
      var m = /[?&]save=([^&#]*)/.exec(window.location.search || '');
      return m ? decodeURIComponent(m[1]) : null;
    }
  }

  // Remove ONLY ?save= from the visible URL (keeping any other params + the
  // hash) via history.replaceState, so a refresh never re-imports the same
  // code. No navigation happens.
  function stripCodeFromUrl() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has(PARAM)) return;
      url.searchParams.delete(PARAM);
      var qs = url.searchParams.toString();
      window.history.replaceState(null, document.title,
        url.pathname + (qs ? '?' + qs : '') + url.hash);
    } catch (e) {
      // older WebKit: blunt replace is better than a re-import loop
      try { window.history.replaceState(null, document.title, window.location.pathname); } catch (e2) {}
    }
  }

  // ----------------------------------------------------------------- QR ----
  // Byte-mode capacity of a full-size (version 40) QR at each error
  // correction level (mirrors qrcodejs' own limit table). Attempt levels from
  // highest correction (densest visual, best damage tolerance) downward:
  // lower levels hold more, and any of them scans trivially for URLs.
  var QR_MAX = [['H', 1273], ['M', 2331], ['Q', 1663], ['L', 2953]];

  function byteLen(s) {
    try { return unescape(encodeURIComponent(s)).length; }
    catch (e) { return s.length; }
  }

  // Draw `text` (the full share URL) as a QR into `container`. Returns
  // { ok: true } or { ok: false, reason } so the UI can swap the canvas for
  // an explanatory note instead of an error.
  function renderQR(container, text) {
    if (!container) return { ok: false, reason: 'nowhere to draw' };
    container.innerHTML = '';
    if (typeof window.QRCode === 'undefined') {
      return { ok: false, reason: 'The QR library failed to load.' };
    }
    var bytes = byteLen(text);
    for (var i = 0; i < QR_MAX.length; i++) {
      // qrcodejs walks its limit table and can fall off the end (TypeError)
      // for oversized input, so only attempt levels that can physically hold
      // the payload; an 8-byte margin covers the QR header bits, where the
      // library's boundary handling is unreliable.
      if (bytes > QR_MAX[i][1] - 8) continue;
      try {
        new window.QRCode(container, {
          text: text,
          width: 192,
          height: 192,
          colorDark: '#0a0c14',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel[QR_MAX[i][0]]
        });
        return { ok: true };
      } catch (e) {
        container.innerHTML = '';   // clear any half-drawn attempt
        // Any failure gets one more chance at the next roomier level; only
        // give up when nothing roomier remains to try.
        var roomy = false;
        for (var j = i + 1; j < QR_MAX.length; j++) {
          if (bytes <= QR_MAX[j][1] - 8) { roomy = true; break; }
        }
        if (!roomy) {
          return /too long|length overflow/i.test(String(e && e.message))
            ? { ok: false, reason: 'This save is too long for a single QR code \u2014 use the link or code instead.' }
            : { ok: false, reason: 'The QR code could not be generated.' };
        }
      }
    }
    // Reaching here means every level was skipped by the capacity check.
    return { ok: false, reason: 'This save is too long for a single QR code \u2014 use the link or code instead.' };
  }

  // ---------------------------------------------------------- CLIPBOARD ----
  // Copy `text`, resolving true only when it really landed on the clipboard.
  // navigator.clipboard requires a secure context; GitHub Pages always is,
  // but keep the old execCommand path for local http:// dev and older Safari.
  function copyText(text) {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);   // iOS needs the explicit range
      var ok = !!(document.execCommand && document.execCommand('copy'));
      ta.parentNode.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  window.SaveCode = {
    PARAM: PARAM,
    enabled: enabled,
    encode: encode,
    decode: decode,
    extractCode: extractCode,
    buildShareUrl: buildShareUrl,
    readCodeFromUrl: readCodeFromUrl,
    stripCodeFromUrl: stripCodeFromUrl,
    renderQR: renderQR,
    copyText: copyText
  };
})();
