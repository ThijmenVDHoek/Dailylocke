// Encrypted, password-protected full-account backup files.
// AES-GCM authenticates the ciphertext: changing even one byte makes import fail.
// A password is intentionally never stored in the file or in browser storage.
(function () {
  var FORMAT = 'dailylocke-encrypted-save';
  var VERSION = 1;
  var ITERATIONS = 310000;
  var MAX_FILE_LEN = 5 * 1024 * 1024;
  function bytes(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
  function b64(a) { var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var raw = atob(s), a = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
  function key(password, salt) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']).then(function (material) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  function supported() { return !!(window.crypto && crypto.subtle && window.TextEncoder && window.TextDecoder); }
  function encrypt(state, password) {
    if (!supported()) return Promise.reject(new Error('Secure save files are not supported by this browser.'));
    if (typeof password !== 'string' || password.length < 10) return Promise.reject(new Error('Use a password or passphrase of at least 10 characters.'));
    var salt = bytes(16), iv = bytes(12), plain = new TextEncoder().encode(JSON.stringify(state));
    return key(password, salt).then(function (k) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, plain); }).then(function (cipher) {
      return JSON.stringify({ format: FORMAT, version: VERSION, kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(cipher)) });
    });
  }
  function decrypt(text, password) {
    if (!supported()) return Promise.reject(new Error('Secure save files are not supported by this browser.'));
    var file;
    try { file = JSON.parse(String(text).replace(/^\uFEFF/, '').trim()); } catch (_) { return Promise.reject(new Error('This is not a valid Dailylocke save file.')); }
    if (!file || file.format !== FORMAT || file.version !== VERSION || !file.salt || !file.iv || !file.ciphertext) return Promise.reject(new Error('This is not a valid encrypted Dailylocke save file.'));
    return key(password, unb64(file.salt)).then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, k, unb64(file.ciphertext)); }).then(function (plain) {
      var data = JSON.parse(new TextDecoder().decode(plain));
      if (!data || data.format !== 'dailylocke-full-state') throw new Error('This save file has an invalid payload.');
      return data;
    }).catch(function (e) { throw new Error(e && /payload/.test(e.message) ? e.message : 'Could not unlock this save. Check the password and make sure the file was not changed.'); });
  }
  function readFile(file) {
    if (!file) return Promise.reject(new Error('Choose a save file first.'));
    if (file.size > MAX_FILE_LEN) return Promise.reject(new Error('That file is too large to be a Dailylocke save.'));
    return file.text ? file.text() : new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = reject; r.readAsText(file); });
  }
  function download(filename, text) { var a = document.createElement('a'), u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.href = u; a.download = filename; a.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }
  window.SaveCode = { supported: supported, encrypt: encrypt, decrypt: decrypt, readFile: readFile, download: download };
})();
