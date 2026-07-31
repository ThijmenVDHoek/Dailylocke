// Plain-text full-account backup files.
// One JSON file contains your complete game: all active runs, avatar, theme,
// Shiny Collection, history, career, and Daily record.
//
// NOTE: backups are deliberately plain JSON -- no encryption, no password.
// They protect against accidental loss and device migration, not against
// someone who has access to the file. The README and the export modal say so;
// the whole transfer flow lives in src/app.js (fullBackupState /
// restoreFullBackup), this module only reads and writes the bytes.
(function () {
  var FORMAT = 'dailylocke-full-state';
  var MAX_FILE_LEN = 5 * 1024 * 1024;

  function readFile(file) {
    if (!file) return Promise.reject(new Error('Choose a save file first.'));
    if (file.size > MAX_FILE_LEN) return Promise.reject(new Error('That file is too large to be a Dailylocke save.'));
    return file.text ? file.text() : new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = reject; r.readAsText(file); });
  }

  function download(filename, text) { var a = document.createElement('a'), u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.href = u; a.download = filename; a.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }

  window.SaveCode = { FORMAT: FORMAT, readFile: readFile, download: download };
})();
