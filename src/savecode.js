// ============================================================================
// savecode.js — cross-device save transfer ("Save Codes" + save files).
//
// 100% client-side, no accounts, no server. Two complementary formats:
//
//   1. SAVE FILE (preferred for size) — plain JSON downloaded as
//      `dailylocke-….json`. No QR capacity limit; works offline via share
//      sheets / AirDrop / USB. Upload the same file on the other device.
//
//   2. SAVE CODE — game state -> JSON -> LZString.compressToEncodedURIComponent()
//      -> a short URL-safe code. Copy as text, embed in a share link
//      (?save=CODE), or render as a QR (vendor/qrcode.js). Codes that exceed
//      QR capacity still transfer fine via the file or the link/code itself.
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

  // Marker written into downloaded JSON so import can tell a real save file
  // from arbitrary JSON a player might drop by mistake.
  var FILE_FORMAT = 'dailylocke-save';
  var FILE_EXT = '.json';

  // Exact alphabet produced by compressToEncodedURIComponent(). Anything
  // outside it is guaranteed not to be one of our codes, which lets the
  // import path reject junk before touching the decompressor.
  var CODE_RE = /^[A-Za-z0-9+\-$]+$/;

  var MAX_CODE_LEN = 9000;   // sanity cap for pasted blobs (paranoia, not spec)
  var MAX_FILE_LEN = 2 * 1024 * 1024;  // 2 MB — a full run is tens of KB

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

  // ----------------------------------------------------------- SAVE FILES --
  // Preferred transfer path when a QR/link would be huge: a plain JSON file
  // the player downloads and re-uploads. No compression, no capacity ceiling,
  // works through any file-share channel (Messages, Drive, AirDrop, USB).

  // Wrap a plain save-state object for download. The format marker lets import
  // reject random JSON; the rest is the same object encode()/loadGameState() use.
  function packFile(state) {
    if (!state || typeof state !== 'object') return '';
    try {
      var out = {};
      Object.keys(state).forEach(function (k) { out[k] = state[k]; });
      out.__format = FILE_FORMAT;
      return JSON.stringify(out);
    } catch (e) { return ''; }
  }

  // Parse a downloaded/uploaded save file. Accepts:
  //   * our JSON save file (with or without __format — older hand-exports)
  //   * a bare save code or share link pasted into a .txt
  // Returns the decoded save-state object, or null.
  function parseFileText(text) {
    if (text == null) return null;
    var t = String(text).replace(/^\uFEFF/, '').trim(); // strip BOM
    if (!t || t.length > MAX_FILE_LEN) return null;

    // JSON save file first — the common case for a .json download.
    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      try {
        var data = JSON.parse(t);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        // Reject clearly-foreign JSON (no run seed and no party and not ours).
        if (data.__format && data.__format !== FILE_FORMAT) return null;
        delete data.__format;
        return data;
      } catch (e) { /* fall through: maybe it's a code with a leading brace somehow */ }
    }

    // Otherwise treat the whole blob as a pasted code / share link.
    var code = extractCode(t);
    return code ? decode(code) : null;
  }

  // Read a File/Blob as text. Resolves the string, or rejects on I/O failure.
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('No file selected.'));
      if (file.size > MAX_FILE_LEN) return reject(new Error('That file is too large to be a Dailylocke save.'));
      // file.text() is modern; FileReader covers older WebKit / Safari.
      if (typeof file.text === 'function') {
        file.text().then(resolve, function () { readViaReader(file, resolve, reject); });
        return;
      }
      readViaReader(file, resolve, reject);
    });
  }

  function readViaReader(file, resolve, reject) {
    try {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Could not read that file.')); };
      fr.readAsText(file);
    } catch (e) { reject(e); }
  }

  // Trigger a browser download of `text` as `filename`. Returns true when the
  // click was dispatched (the browser still owns whether the download lands).
  function downloadText(filename, text, mime) {
    if (text == null || text === '') return false;
    try {
      var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
      var url = (window.URL || window.webkitURL).createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || ('dailylocke-save' + FILE_EXT);
      a.rel = 'noopener';
      // iOS Safari needs the element in the tree for the download to fire.
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        try { a.parentNode && a.parentNode.removeChild(a); } catch (e) {}
        try { (window.URL || window.webkitURL).revokeObjectURL(url); } catch (e) {}
      }, 1500);
      return true;
    } catch (e) { return false; }
  }

  // A short, filesystem-safe name: dailylocke-daily-s3-2026-07-31.json
  function fileNameFor(state) {
    var bits = ['dailylocke'];
    if (state && state.mode === 'daily') {
      bits.push('daily');
      if (state.dailyDate) bits.push(String(state.dailyDate));
    } else if (state && state.mode === 'gauntlet') {
      bits.push('gauntlet');
    } else if (state && state.mode === 'profile') {
      bits.push('profile');
    } else {
      bits.push('free');
    }
    if (state && state.section) bits.push('s' + state.section);
    var d = new Date();
    bits.push(
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
    );
    return bits.join('-').replace(/[^a-zA-Z0-9._-]+/g, '-') + FILE_EXT;
  }

  // ----------------------------------------------------------------- QR ----
  // Byte-mode capacity of a full-size (version 40) QR at each error
  // correction level (mirrors qrcodejs' own limit table). Attempt levels from
  // highest correction (densest visual, best damage tolerance) downward:
  // lower levels hold more, and any of them scans trivially for URLs.
  //
  // Long saves often exceed every level — that is expected. The UI then points
  // the player at the save-file download, which has no size ceiling.
  var QR_MAX = [['H', 1273], ['M', 2331], ['Q', 1663], ['L', 2953]];

  function byteLen(s) {
    try { return unescape(encodeURIComponent(s)).length; }
    catch (e) { return s.length; }
  }

  // True when `text` cannot fit in any single QR. Used to demote the QR UI
  // before we even try to draw (avoids a half-second of failed attempts).
  function qrFits(text) {
    var bytes = byteLen(text || '');
    for (var i = 0; i < QR_MAX.length; i++) {
      if (bytes <= QR_MAX[i][1] - 8) return true;
    }
    return false;
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
    var tooLongMsg = 'This save is too long for a QR code \u2014 download the save file instead.';
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
            ? { ok: false, reason: tooLongMsg }
            : { ok: false, reason: 'The QR code could not be generated.' };
        }
      }
    }
    // Reaching here means every level was skipped by the capacity check.
    return { ok: false, reason: tooLongMsg };
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
    FILE_FORMAT: FILE_FORMAT,
    FILE_EXT: FILE_EXT,
    enabled: enabled,
    encode: encode,
    decode: decode,
    extractCode: extractCode,
    buildShareUrl: buildShareUrl,
    readCodeFromUrl: readCodeFromUrl,
    stripCodeFromUrl: stripCodeFromUrl,
    packFile: packFile,
    parseFileText: parseFileText,
    readFile: readFile,
    downloadText: downloadText,
    fileNameFor: fileNameFor,
    qrFits: qrFits,
    renderQR: renderQR,
    copyText: copyText
  };
})();
