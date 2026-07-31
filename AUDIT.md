# Dailylocke — Full Code Audit

**Date:** 2026-07-31 · **Commit audited:** `43b2439` (branch `arena/019fb839-dailylocke`) · **Scope:** `src/`, `index.html`, `sw.js`, `manifest.json`, `vendor/` (partially), `tools/`, `README.md`, CI configs.

The audit covers code correctness, functionality, design, security, offline/PWA behaviour, testing/CI, and documentation accuracy. Findings are severity-ranked. Line numbers refer to the audited commit.

> **Update — fixes applied (2026-07-31):** all findings marked ✅ below have been
> implemented in the working tree. `npm run check` (lint + 289 JSDOM smoke
> checks + service-worker revision guard) is fully green. The Playwright e2e
> suite could not be executed in this sandbox (the browser CDN is unreachable);
> it skips cleanly by design. The stale e2e references to the removed save-code
> UI were updated to the current backup flow regardless.

---

## Fix status

| Finding | Status |
| --- | --- |
| H1 — quality gate red (3 lint errors, smoke-test crash, stale SW rev) | ✅ fixed; `npm run check` green (289/289). CI workflow staged at `tools/ci/check.yml` — activating it in `.github/workflows/` needs a maintainer with `workflows` permission (this session's GitHub App lacks it, so the push was rejected) |
| H2 — stale `SHELL_REV` | ✅ regenerated (`9cd45eeab0f9` → `86a1fbcfe211`) |
| H3 — README claims encrypted backups that don't exist | ✅ README + module table + export copy now describe plain-JSON backups honestly |
| H4 — stored XSS via import (validation + escaping + avatar allow-list) | ✅ `restoreFullBackup` validates/migrates/sanitizes everything; nicknames escaped in every `innerHTML` path; `profile.avatar` allow-listed; ui-patch escapes panel names too |
| H5 — import can brick the app | ✅ invalid runs reject the whole restore with a clear message (tested) |
| M1 — Daily AI not deterministic | ✅ AI jitter is seeded per Daily battle (`dailyAIRand`); Free Play keeps `Math.random`; unit-tested |
| M2 — lossy auto-resume | ✅ all enemies restored (items + elite included), field effect recomputed, `_isResume` moved to a non-persisted module flag consumed on the first request |
| M3 — bag "take" skips forme enforcement | ✅ routes through `Forme.setHeldItemAndEnforce` |
| M4 — `ui.s.st` typo | ✅ `ui.s.p.st` |
| M6 — dead code/vendor/docs | ✅ `vendor/lz-string.min.js` + `vendor/qrcode.js` removed (notices updated), `Nuz.rollShiny` export removed, `SaveCode.supported` removed, `FORMAT` now shared, README size claim corrected, stale smoke-test save-code block replaced with backup round-trip tests, `btnTitleLoad` e2e ref fixed, `cause` added to re-thrown error |
| L2 — save-every-damage-tick | ⏸ not changed (correctness first; a debounce is a safe follow-up) |
| L1/L3/L4/L5/L6 — design notes | ⏸ left as noted |

---

## Executive summary

Dailylocke is an unusually well-engineered client-side game: a real battle simulator (`@pkmn/sim`), a split module graph, a genuinely thoughtful PWA strategy (content-hashed shell, bounded runtime caches, relative paths, self-hosted fonts), a WAI-ARIA modal controller, and a substantial test suite. The game logic around determinism, migrations, and identity-mapped battle state shows real care.

However, the repository is **currently not green on its own quality gate**, and there are a handful of real issues:

1. **The project's own checks fail** — lint has 3 errors, the JSDOM smoke test crashes (`SC.enabled is not a function`), and the service-worker revision is stale. CI is not active and the deploy workflow runs **no checks at all**, so a broken build can reach GitHub Pages untouched.
2. **The README documents a backup-encryption feature that does not exist.** The README promises password-protected, PBKDF2-SHA-256 + AES-256-GCM encrypted backups; the code exports plain JSON with no password, no crypto, and the UI has no password field.
3. **Stored XSS via backup import** — imported save data is written to storage without validation, and unescaped player-controlled strings (nicknames, avatar id) are interpolated into `innerHTML` in many places.
4. **Daily runs are not fully deterministic** despite the README's claim: the AI's move choice uses `Math.random()`, so two players on the same day's puzzle can get different AI decisions (and therefore different battles).
5. **Mid-battle auto-resume is lossy** for trainer battles (only the first enemy is restored) and drops field effects/elite modifiers.

---

## Critical / High

### H1. The repository fails its own quality gate (`npm run check` is red)

All three stages of `tools/package.json` → `check` fail:

- **ESLint (3 errors):**
  - `src/app.js:4600` — `preserve-caught-error`: a caught parse error is re-thrown as `new Error('This is not a valid Dailylocke save file.')` without `cause`, so the original error is lost.
  - `src/savecode.js:5` — `FORMAT` is assigned but never used.
  - `tools/smoke-test.mjs:658` — `freeCode` is assigned but never used.
- **Smoke test crashes:** `tools/smoke-test.mjs:501` calls `SaveCode.enabled()`, but the current `src/savecode.js` only exposes `supported()/readFile/download`. The test still exercises the **removed** save-code API (`encode`, `decode`, `packFile`, `parseFileText`, `enabled`, plus `window.LZString` / `window.QRCode`, which `index.html` no longer loads). The suite dies with `TypeError: SC.enabled is not a function` after 2 prior failures (`lz-string loaded`, `qrcode.js loaded`).
- **Service-worker revision guard:** `node tools/build-sw.mjs --check` reports `sw.js shell revision is STALE: 9cd45eeab0f9 -> 46726f6f1df9`.

**Why it matters:** `.github/workflows/static.yml` deploys `main` to GitHub Pages with zero checks; the CI workflow that would catch this (`tools/ci/check.yml`) is deliberately not installed (and the README itself calls this out: "nothing today stops a broken build from going live"). So the current tree is exactly the broken state that gate was built to prevent.

*Fix:* fix the 3 lint errors, update/delete the dead save-code block in `smoke-test.mjs`, run `npm run build:sw --prefix tools` and commit the new `SHELL_REV`, then activate `tools/ci/check.yml` by moving it into `.github/workflows/`.

### H2. Stale service-worker shell revision → returning players can be stranded on old JS forever

`sw.js` `SHELL_REV = '9cd45eeab0f9'` does not match a content hash of the current shell files (should be `46726f6f1df9`). This is the exact failure mode the README describes: a deploy that changes shell files without bumping the revision leaves `sw.js` byte-identical, so browsers never re-install the worker and the old precached `src/app.js` etc. are served indefinitely. The check that would catch this is not wired into the deploy path (see H1). **Do not deploy the current tree without regenerating the revision.**

### H3. README documents "encrypted full-game backups" that do not exist

The README (`## Encrypted full-game backups`) and its module table state:

> "Choose **Transfer save**, enter a backup password of at least 10 characters, and download the encrypted backup… Files use PBKDF2-SHA-256 (310,000 iterations) to derive an AES-256-GCM key. AES-GCM encrypts the data and authenticates it… a modified, corrupt, or wrong-password file cannot be accepted."

The implementation does none of this:

- `src/savecode.js` — 19 lines: `download()` writes `JSON.stringify(state)` as a plain `.json` file; the header comment even says "Plain-text full-account backup files".
- `src/app.js` `downloadCurrentSave()` — `JSON.stringify(state)` → `SaveCode.download(...)`.
- `index.html` — the export/import overlays contain **no password field at all**.
- There is no `crypto.subtle`, PBKDF2, or AES anywhere in `src/`.

Either the encryption feature was removed and the README was never updated (most likely, given the honest comment in `savecode.js` and the removed save-code system), or the feature is missing. The README's step-by-step instructions describe UI that does not exist. This is a user-facing trust problem: players are told their saves are "encrypted and authenticated" when they are plain text and trivially editable. **Update the README (and the app's export modal copy) to describe plain JSON backups, or implement the encryption.**

### H4. Stored XSS via save-file import (and self-XSS via nicknames)

`restoreFullBackup()` (`src/app.js`) writes imported `runs` / `profile` / `daily` data into `localStorage` with **no validation** — `Storage.validate()` exists but is never called anywhere in the app. Meanwhile, many render paths interpolate player-controlled strings into `innerHTML` **unescaped** (`escapeHtml` is used only ~20 times):

- Nicknames → `mon.name`:
  - `drawTeamStrip` (`'<span class="ts-name">' + m.name + '</span>'`)
  - `drawPartyDetail` (`'<div class="pd-name">' + mon.name + '</div>'`)
  - battle party switcher (`showPartyPanel`), picker rows, grave rows, section summary (`'<b>' + m.name + '</b>'`), game-over roster (`'<span class="ros-n">' + r.name + '</span>'`), catch swap buttons, and `$('evoText').innerHTML = mon.name + ' became…'`.
- `profile.avatar` → `updateMenuAvatar()` builds `'<img src="' + avatarUrl(profile.avatar) + '" alt="">'` with no allow-list, so an imported avatar like `x.png" onerror="…` breaks out of the attribute.

Nickname input is capped at 12 chars client-side, which limits UI-typed payloads, but a **crafted backup file bypasses that entirely** (names and avatar are stored verbatim and executed on next render). Because the import flow is the advertised cross-device transfer mechanism, this is a genuine stored-XSS vector — an attacker who gets a victim to import a malicious backup can run arbitrary JS in the victim's session. Malformed-but-non-malicious imports can also brick the app (H5).

*Fix:* run every imported run through `Storage.validate()`/migration before `putRun`, allow-list `profile.avatar` against the `AVATARS` list, and HTML-escape all `mon.name`/nickname interpolations (or build DOM with `textContent`).

---

## Medium

### M1. Daily battles are not deterministic for everyone — the AI uses `Math.random()`

The README promises: "Battles are deterministic. Crits, misses and damage rolls are identical for everyone playing that day's challenge." Engine rolls are correctly seeded via `dailyBattleSeed()`, but the situational AI in `src/battle.js` uses unseeded randomness:

- `scoreAIMove` returns `score + Math.random() * 5` for attacks (line 105), `base + Math.random() * 8` for unknown status moves (160), and `base + Math.random() * 6` (162).

Whenever two moves score within a few points of each other — common, since the jitter is applied after the main scoring — different players on the same Daily will see the opponent choose different moves, and the battle then diverges. The music picker deliberately uses `Math.random()` (correct, documented), but the AI choice should be deterministic for Daily runs (derive from the battle seed / a per-turn hash) to keep the "identical for everyone" promise.

### M2. Mid-battle auto-resume is lossy for trainer battles

The boot auto-resume path (`src/app.js` ~line 4690) rebuilds only `cfg.enemies[0]`:

- A trainer's remaining team members (up to 5) are **dropped** — a 6v6 trainer fight becomes a 6v1 after a refresh.
- `fieldEffect` is forced to `null`, so the ascension field (weather/terrain/hazards/room) that was previewed and applied is gone.
- Enemy `elite` modifiers are not restored.
- `run._isResume` is set `true` then immediately `false` synchronously after `beginBattle(...)`, before the first engine request arrives asynchronously — so the resume HP/status override block at `app.js:3241` never executes (dead code; HP is actually restored by `injectPersistence`, but the block and its comment are misleading).

*Fix:* restore the full `cfg.enemies` array from `run._battleCfg`, rebuild field effect and elite data, and keep `_isResume` true until the first request is handled.

### M3. "Take item" from the Bag does not enforce forme consistency

`drawOwned`'s take handler does `m.item = ''` directly, while the party-detail take handler correctly calls `Forme.setHeldItemAndEnforce(run, mon, '')`. So removing a forme-forcing item (Griseous Core, Adamant Crystal, plates, etc.) from the Bag leaves the Pokémon in the forced forme (e.g., Giratina-Origin without its Core) until the next load, when `reviveRun`'s async enforcement eventually snaps it back. Inconsistent code paths for the same operation — route both through `setHeldItemAndEnforce`.

### M4. `ui.s.st` typo breaks the live status badge in the battle party switcher

`src/app.js:3409` (`showPartyPanel`): `var liveStatus = isActive && ui && ui.s && ui.s.p ? ui.s.st : m.status;`

In `vendor/battle-ui.js` the status lives at `s.p.st` / `s.e.st`; `ui.s.st` is always `undefined`. The HP path (`ui.s.p.hp`) is correct, but the status badge for the currently-out Pokémon in the in-battle switch panel will never reflect a mid-battle status (e.g., a lead burned in the current fight shows no burn badge). Should be `ui.s.p.st`.

### M5. Backup import does no validation and can brick the app

`restoreFullBackup()` writes `data.runs[mode]` straight into slots and `data.profile` into the profile, with no schema checks, no `SAVE_VERSION` check, and no call to the existing `Storage.validate()`. A truncated/corrupt/hand-edited backup (missing `seed`, party member without `id`, non-array `party`, `__v` in the future) will be accepted, then crash `reviveRun()` or render code on the next boot/render. Given backups are now plain JSON (H3), users are more likely to hand-edit them — and the app should reject anything invalid with a clear message. Wire `Storage.validate()` (plus version check + migration) into the import path.

### M6. Dead code, unused vendor files, and stale documentation

- **`vendor/lz-string.min.js` + `vendor/qrcode.js`** are shipped, listed in `THIRD_PARTY_NOTICES.md` and `vendor/README.md` as part of the save-code flow, but **not loaded by `index.html`** — the save-code/QR feature was removed. Dead weight in the deploy artifact; remove them or the notices.
- **`Storage.validate()`** — implemented (with a good error-message design) but never called by the app; only the smoke test exercises it (and, ironically, the smoke test is what crashes).
- **`Nuz.rollShiny()`** — legacy, exported but never called (all wild shinies use `rollShinyDeterministic`).
- **`SaveCode.supported()`** — never called (always `true`).
- **`Evo.canEvolve()`** checks `req.extraItem`, which `requirementFor()` never sets — dead field.
- **`PWA.refresh`** exposed but never called by the app.
- **`Storage.available()`** — comment says "used to warn the player once", but no warning is ever shown in `app.js`.
- **README**: "`app.js` is ~197 KB today" — actual size is 249,142 bytes (~243 KB). Also the module table's description of `savecode.js` ("password-encrypted, authenticated full-backup files") is false (H3).

---

## Low / design notes

### L1. `recordShiny` can log the same shiny multiple times
A shiny that evolves or forme-changes calls `recordShiny` again with a new `mon.id`, so the Shiny Collection can show the same Pokémon twice (pre-/post-evolution), and `hasCollectedShiny(id)` fails to recognize the evolved forme (the Gauntlet "make shiny" toggle disappears). Consider keying the collection by base species or updating the existing entry on evolution.

### L2. Frequent `localStorage` writes mid-battle
`handleLine` calls `syncBattleToRun(); saveGame();` on every player `-damage` / `-heal` / `-status` / faint event — i.e., a full `JSON.stringify` of the run on every damage tick. Correct, but on large runs and slow phones this can jank the animation queue. A debounce (e.g., write at most every 500 ms) would be safer.

### L3. Enemy EV spreads can exceed the 510 total
`applyTraining` for wall/disruptor roles sets `hp=252, def≈151, spd≈151, atk/spa≈101` (sum ≈ 655) for late sections. `@pkmn/sim` clamps per-stat to 252 and doesn't reject the total, so it works, but the spread silently violates the standard 510-EV cap — worth normalizing for consistency with the player-facing Stat Points system (66 SP ≈ 508 EVs).

### L4. `gbFormeChange` / `gbRunFormeChange` boolean logic is hard to read
`!Forme || !(CUSTOM[itemId]) && (item mismatch) || !targets…` relies on operator precedence; it behaves correctly but is a one-character refactor away from a bug. Parenthesize explicitly.

### L5. `Math.round` in `daysBetween`
Daily streak/calendar math uses `Math.round(diff/86400000)` to absorb DST — correct for ±1 h shifts, but it also silently rounds *any* sub-day drift, which is acceptable for this use. Worth a comment (it has one).

### L6. `:`-heavy CSS `:has()` usage
`ui-patch.js` uses `.mv:has(.party-grid)` — requires Chrome 105+/Safari 15.4+/Firefox 121+. Fine for a 2026 title but worth noting if legacy-browser support is ever a goal; there is no fallback layout for the battle switcher.

### L7. No obvious crash-safety around `URL.revokeObjectURL`
`SaveCode.download` revokes the object URL after 1 s. Fine for normal files, but an extremely slow download start (mobile) could theoretically revoke before the fetch begins. Harmless in practice.

### L8. Music is remote-only
Battle music streams from `play.pokemonshowdown.com`; the offline story covers the app shell and sprites/cries the player has already seen, but not music. This is documented behaviour, not a bug — listed for completeness.

---

## What's genuinely good (worth preserving)

- **Deterministic world generation** (`drand()`-keyed hashes for encounters, trainer teams, field effects, elites, mart stock) with a clean separation from the battle RNG used for catch shakes — and `randState` persisted so refresh doesn't re-roll.
- **Identity-mapped battle state** (`__tag` stamping instead of index mapping) — the wrapper explicitly avoids the classic Showdown party-reordering bug, and the comment explains the historical failure.
- **Staged battle start** (write `p1` before `p2` so injected HP lands in the first `|switch|`) — a genuinely subtle engine-integration detail done right.
- **PWA discipline**: relative paths, per-file `cache.add()` instead of atomic `addAll()`, bounded and separately-owned runtime caches with oldest-first eviction, content-hashed shell revision, self-hosted fonts, bundled SVG sprite fallbacks, `preconnect`/`preload` tuning.
- **Modal controller**: WAI-ARIA dialog pattern with focus trap, Escape handling, `inert` background, stacked dialogs, focus restore — better than most production web apps.
- **Accessibility details**: `aria-live` toasts, labelled dialogs, keyboard tooltips, `prefers-reduced-motion` support, visible focus states.
- **Migration discipline**: `SAVE_VERSION` bumps with stepwise v1→v2→v3 migrations, defensive `loadProfile`/`load` fill-ins, and clear comments about why each field exists.
- **Honest difficulty design**: ascension is previewed on the route screen ("a difficulty system the player can't see is just unfairness") — a principled stance.
- **Error containment**: battle startup failures get a real retry/bail screen; `onError` handlers exist on every stream; sprite chains always terminate locally.

---

## Prioritized action list

1. **Before any deploy:** run `npm run build:sw --prefix tools` and commit the new `SHELL_REV` (H2). Deploying the current tree risks stranding players on stale JS.
2. **Fix the quality gate:** 3 lint errors, the dead save-code block in `smoke-test.mjs`, and activate `tools/ci/check.yml` so `main` can't deploy broken (H1).
3. **Reconcile the backup story:** either implement the documented password/AES-GCM encryption or rewrite the README + modal copy to say "plain JSON backup" (H3).
4. **Harden the import path:** validate/migrate imported data (`Storage.validate`), allow-list `profile.avatar`, escape all nickname interpolation — closes the stored-XSS and bricking vectors (H4, H5).
5. **Make the Daily truly deterministic:** seed the AI's move choice (M1).
6. **Fix auto-resume:** restore the full enemy team, field effect, and elite state; fix the `_isResume` timing (M2).
7. **Small correctness fixes:** `ui.s.p.st` (M4), bag-take forme enforcement (M3), `cause` on re-thrown errors (H1 lint).
8. **Housekeeping:** remove dead vendor files/notices, unused exports (`validate`, `rollShiny`, `supported`, `PWA.refresh`), and update the README's app.js size claim (M6).
