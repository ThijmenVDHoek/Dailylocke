# Dailylocke — Full Code Audit

**Date:** 2026-07-31 · **Commit audited:** `43b2439` (branch `arena/019fb839-dailylocke`) · **Scope:** `src/`, `index.html`, `sw.js`, `manifest.json`, `vendor/` (partially), `tools/`, `README.md`, CI configs.

The audit covers code correctness, functionality, design, security, offline/PWA behaviour, testing/CI, and documentation accuracy. Findings are severity-ranked. Line numbers refer to the audited commit.

> **Update — fixes applied:** all findings marked ✅ below have been implemented
> in the working tree. `npm run check` covers lint, the JSDOM smoke suite and the
> service-worker revision guard. An active GitHub Actions workflow additionally
> installs Chromium/SwiftShader and runs the focused WebGL lifecycle smoke test;
> the Pages deploy waits for that gate.

---

## Fix status

| Finding | Status |
| --- | --- |
| H1 — quality gate red (3 lint errors, smoke-test crash, stale SW rev) | ✅ fixed; `npm run check` green. CI is active at `.github/workflows/check.yml` and the Pages deploy gates on the same checks |
| H2 — stale `SHELL_REV` | ✅ regenerated (`9cd45eeab0f9` → `86a1fbcfe211`) |
| H3 — README claims encrypted backups that don't exist | ✅ README + module table + export copy now describe plain-JSON backups honestly |
| H4 — stored XSS via import (validation + escaping + avatar allow-list) | ✅ `restoreFullBackup` validates/migrates/sanitizes everything; nicknames escaped in every `innerHTML` path; `profile.avatar` allow-listed; ui-patch escapes panel names too |
| H5 — import can brick the app | ✅ invalid runs reject the whole restore with a clear message (tested) |
| M1 — Daily AI not deterministic | ✅ AI jitter is seeded per Daily battle (`dailyAIRand`); Free Play keeps `Math.random`; unit-tested |
| M2 — lossy auto-resume | ✅ all enemies restored (items + elite included), field effect recomputed, `_isResume` moved to a non-persisted module flag consumed on the first request |
| M3 — bag "take" skips forme enforcement | ✅ routes through `Forme.setHeldItemAndEnforce` |
| M4 — `ui.s.st` typo | ✅ `ui.s.p.st` |
| M6 — dead code/vendor/docs | ✅ `vendor/lz-string.min.js` + `vendor/qrcode.js` removed (notices updated), `Nuz.rollShiny` export removed, `SaveCode.supported` removed, `FORMAT` now shared, README size claim corrected, stale smoke-test save-code block replaced with backup round-trip tests, `btnTitleLoad` e2e ref fixed, `cause` added to re-thrown error |
| L2 — save-every-damage-tick | ✅ battle persistence is debounced to 500 ms and flushed at request/screen boundaries |
| L1/L3/L4/L5/L6 — design notes | ⏸ left as noted |

---

## Executive summary

Dailylocke is an unusually well-engineered client-side game: a real battle simulator (`@pkmn/sim`), a split module graph, a genuinely thoughtful PWA strategy (content-hashed shell, bounded runtime caches, relative paths, self-hosted fonts), a WAI-ARIA modal controller, and a substantial test suite. The game logic around determinism, migrations, and identity-mapped battle state shows real care.

The original findings below are retained as historical evidence from the audited
commit. The current tree has the quality gate and Pages dependency active, the
backup/import and Daily/auto-resume fixes applied, and the remaining open items
are explicitly marked in the status table.

---

## Critical / High

### H1. The repository fails its own quality gate — resolved

This historical finding covered the removed save-code test path, lint errors and a
stale service-worker revision. The current gate is active at
`.github/workflows/check.yml`; `npm run check --prefix tools` is green, and the
Pages deployment waits for the same check plus the headless browser smoke test.

### H2. Stale service-worker shell revision — resolved

The worker revision is generated from the current shell contents and is checked by
CI before Pages deployment. The current revision is regenerated with
`npm run build:sw --prefix tools`.

### H3. README documents "encrypted full-game backups" that do not exist — resolved

The README (`## Encrypted full-game backups`) and its module table state:

> "Choose **Transfer save**, enter a backup password of at least 10 characters, and download the encrypted backup… Files use PBKDF2-SHA-256 (310,000 iterations) to derive an AES-256-GCM key. AES-GCM encrypts the data and authenticates it… a modified, corrupt, or wrong-password file cannot be accepted."

The implementation does none of this:

- `src/savecode.js` — 19 lines: `download()` writes `JSON.stringify(state)` as a plain `.json` file; the header comment even says "Plain-text full-account backup files".
- `src/app.js` `downloadCurrentSave()` — `JSON.stringify(state)` → `SaveCode.download(...)`.
- `index.html` — the export/import overlays contain **no password field at all**.
- There is no `crypto.subtle`, PBKDF2, or AES anywhere in `src/`.

Either the encryption feature was removed and the README was never updated (most likely, given the honest comment in `savecode.js` and the removed save-code system), or the feature is missing. The README's step-by-step instructions describe UI that does not exist. This is a user-facing trust problem: players are told their saves are "encrypted and authenticated" when they are plain text and trivially editable. **The README and export modal now describe plain JSON backups honestly.**

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
- **README** now reports the measured ~369 KB app controller and the post-paint loader split; the module table describes the plain-JSON backup format honestly.

---

## Low / design notes

### L1. `recordShiny` can log the same shiny multiple times
A shiny that evolves or forme-changes calls `recordShiny` again with a new `mon.id`, so the Shiny Collection can show the same Pokémon twice (pre-/post-evolution), and `hasCollectedShiny(id)` fails to recognize the evolved forme (the Gauntlet "make shiny" toggle disappears). Consider keying the collection by base species or updating the existing entry on evolution.

### L2. Frequent `localStorage` writes mid-battle — resolved
Battle damage, healing, status, and faint events schedule one persistence write
within a 500 ms window. The pending write is flushed before a player request and
when a battle screen is torn down, preserving crash/reload correctness without
serializing the whole run for every animation tick.

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

1. **Keep the active gates green:** `npm run check --prefix tools` plus `npm run test:browser --prefix tools` (H1/H2).
2. **Reconcile the backup story:** either implement the documented password/AES-GCM encryption or keep all copy explicitly plain JSON (H3).
3. **Harden the import path:** validate/migrate imported data (`Storage.validate`), allow-list `profile.avatar`, escape all nickname interpolation — closes the stored-XSS and bricking vectors (H4, H5).
4. **Make the Daily truly deterministic:** seed the AI's move choice (M1).
5. **Fix auto-resume:** restore the full enemy team, field effect, and elite state; fix the `_isResume` timing (M2).
6. **Small correctness fixes:** `ui.s.p.st` (M4), bag-take forme enforcement (M3), `cause` on re-thrown errors (H1 lint).
7. **Housekeeping:** remove dead vendor files/notices, unused exports (`validate`, `rollShiny`, `supported`, `PWA.refresh`), and update the README's app.js size claim (M6).  
8. **3D engine audit:** all items in the appendix below have been reviewed and fixed (see Appendix: 3D Engine Audit).

---

## Appendix: 3D Engine Audit

**Date:** 2026-08-16 · **Scope:** `vendor/battle-ui.js` (the 3D battle scene), `vendor/three.min.js` (bundled Three.js r144), `src/renderer-loader.js` (progressive-loading orchestrator), `src/ui-patch.js` (HUD overlay), `src/app.js` (3D integration).

### Summary

The 3D battle engine uses a DOM-sprite-projection architecture: Three.js manages the WebGL scene (biome, weather, terrain, lighting, particles), while Pokémon sprites are rendered as DOM `<img>` elements projected from 3D world coordinates via perspective math. This avoids CORS issues with Showdown's animated GIFs and keeps GIF animation native. The renderer is loaded progressively after the first paint, so the game is usable before WebGL is available.

### Issues found and fixed

#### Critical

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| C1 | **Color-space no-op on bundled Three.js r144** — `r.outputColorSpace = T.SRGBColorSpace` silently does nothing because `outputColorSpace`/`SRGBColorSpace` were added in r152. The bundled r144 uses `outputEncoding`/`sRGBEncoding`. The entire scene renders in linear color space, making colours washed out/dark. | **CRITICAL** — visual output incorrect on the bundled version | Version-agnostic detection: `if('outputColorSpace' in r && T.SRGBColorSpace) r.outputColorSpace = T.SRGBColorSpace; else if('outputEncoding' in r && T.sRGBEncoding) r.outputEncoding = T.sRGBEncoding;` |
| C2 | **Flat mode shows no Pokémon sprites** — When WebGL is unavailable (context loss, no GPU, rendering disabled), `_anim()` returns early at `if(!this.r||!this.sc||!this.cam)return;` before `_projectSprites()` ever runs. The DOM sprites stay at `opacity: 0` and the battle is unplayable — just a gradient background and HUD. | **CRITICAL** — game broken on any device without WebGL | Split the guard: `if(!this.sc||!this.cam)return;` still allows DOM sprite projection. Only the `r.render()` call is guarded with `if(this.r&&!this.flat)`. The weather/field/particle stepping also runs in flat mode. |
| C3 | **Unbounded image cache** — `CACHE` and `FAILED` global objects grow without limit, keeping every sprite URL ever loaded and every URL that 404'd. Over a long play session this can consume hundreds of MB of image memory. | **HIGH** — memory leak over time | Added LRU cap: `CACHE_MAX = 600`, `FAILED_MAX = 300`. New `cachePut()`/`cacheFail()` functions handle eviction. `preload()` uses them. |

#### High

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| H1 | **`getBoundingClientRect()` every frame in `_projectSprites()`** — forces layout/reflow 60 times per second. The rect is also read in `floatN()` and `floatT()` on every damage/heal/message popup. | **HIGH** — layout thrashing, poor battery life and frame drops on mobile | Cached `_hostRect` with periodic refresh: rect is read at most every 20 frames (~3×/s at 60 fps) unless `_hostRectAge` is manually invalidated (on resize, on mount). `floatN()`/`floatT()` prefer the cached rect and fall back to `getBoundingClientRect()` only when the cache is stale. |
| H2 | **Terrain mote particles update every frame even when invisible** — `_stepField` steps the 120 mote positions, velocities, and drift every frame regardless of whether a terrain is active (Electric/Grassy/Misty/Psychic). | **HIGH** — wasted CPU on invisible particle system | Gated: `if(f.motes && f.tp > 0.004)` — the opacity threshold is the same one used to decide visibility. |
| H3 | **Canvas 2D context not guarded** — `terrainTex()` and `roomTex()` call `cv.getContext('2d')` without checking the result. If the 2D context is unavailable (rare, but possible in privacy modes or resource-constrained environments), the crash propagates to `_reportError()` and kills the battle. | **HIGH** — crash on edge case | Added `if(!x) return solid-color texture;` guard in both functions. |
| H4 | **Procedural textures have no colorSpace/encoding** — Terrain/Room procedural textures from `terrainTex()`/`roomTex()` use `new THREE.Texture(cv)` which defaults to `NoColorSpace`/`LinearEncoding`. With the renderer now correctly outputting sRGB, these textures would double-transform and look washed out. | **HIGH** — cosmetic / incorrect rendering | Set `texture.colorSpace = THREE.SRGBColorSpace` (or `texture.encoding = THREE.sRGBEncoding` for pre-r152) on all procedural textures. |

#### Medium

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| M1 | **iOS detection using deprecated `navigator.platform`** — `navigator.platform` is deprecated and returns empty strings in some contexts (cross-origin iframes, hardened browsers). | **MEDIUM** — wrong DPR cap on edge cases | Added `navigator.userAgent` fallback with more robust iPad detection. |
| M2 | **Context loss polling** — When the WebGL context is lost, `RendererSession.state` is set to `'lost'` and `acquire()` returns `null` forever. If the context restores without the DOM event firing (known WebKit bug), the game stays in flat mode permanently. | **MEDIUM** — stuck in flat mode on some devices | Added `_startLostWatch()`/`_stopLostWatch()`: when in 'lost' state, a 2-second interval probes for context availability via a hidden canvas. If context is restored, state flips to 'ready' and the current owner is notified. |
| M3 | **CSS `width: 100vw` on pseudo-elements** — On some mobile browsers (especially with visible scrollbar), `width: 100vw` can overflow the viewport and cause horizontal scrolling. | **MEDIUM** — cosmetic | Changed to `width: auto; left: 0; right: 0;` which works correctly in all browsers for fixed-position elements. Same fix applied to `.topbar` (which used `width: 100vw; margin-left: -50vw; margin-right: -50vw;`). |
| M4 | **Renderer loader has no retry** — If `vendor/three.min.js` fails to load (transient network, CDN flake), the 3D engine never retries. The progress promise rejects permanently. | **MEDIUM** — resilience | Added single retry with 1.5 s backoff to `loadScript()` in `renderer-loader.js`. |

#### Low / Design Notes

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| L1 | **`_setTex` sprite chain walking can race with reassignment** — The `_texGen` counter approach is correct for single-thread JS, but the chain's `setTimeout`/`Promise` callbacks can fire after the sprite slot has been reassigned to a different species. The `alive()` check guards against this. | **LOW** — already guarded | No change needed; `alive()` checks `s._texGen === gen` and `s.img` existence. |
| L2 | **`terrainTex` creates 256×256 canvas textures per terrain type** — Stored in `f.tex` map, never disposed. Only 4 terrain types exist, so memory is negligible. | **LOW** | Noted, acceptable. |
| L3 | **Weather particles (`rain` 900, `snow` 250, `sand` 300, `hail` 220, `sunmotes` 90) all step every frame regardless of visibility** — `_anim` already checks `pt.visible` before stepping each weather system. | **LOW** — already efficient | Noted, no change needed. |
| L4 | **`ACESFilmicToneMapping` is used regardless of Three.js version** — Present since r114, so compatible with r144+. | **LOW** | Noted, no change needed. |
| L5 | **`_burst` particle systems are created with `new BufferGeometry` each time and disposed after TTL** — Particles are infrequent (attacks, mega evolution, status) so this is fine. | **LOW** | Noted, acceptable. |
| L6 | **Sprite `onerror` chain in `app.js` uses `arguments.callee` in inline handler string** — The string is evaluated as code, so `arguments.callee` works inside the evaluated function. | **LOW** — works but fragile | Noted, acceptable for current usage. |

### Key architectural improvements

1. **Color-space version detection** — The renderer now detects the Three.js version's API at runtime and uses `outputColorSpace`/`SRGBColorSpace` (r152+) or `outputEncoding`/`sRGBEncoding` (pre-r152) as appropriate. This fixes the silent no-op on the bundled r144 and will auto-adapt if the Three.js bundle is ever upgraded.

2. **Flat-mode sprite rendering** — The core fix of the audit. `_anim()` now projects DOM sprites, steps weather/field/particles, and handles context-loss detection regardless of whether a WebGL renderer exists. Only the actual `r.render()` call is guarded. This means the battle is fully playable on any device, with or without WebGL.

3. **Bounded LRU image cache** — The global `CACHE` and `FAILED` maps now have caps (600 and 300 entries respectively) to prevent memory growth over time. The oldest entries are evicted as new ones arrive.

4. **Layout-friendly rendering** — The per-frame `getBoundingClientRect()` call is replaced with a cached rect refreshed at most 3 times per second, plus on resize. This eliminates the primary source of layout thrashing in the animation loop.

5. **Context-loss recovery** — If the WebGL context is lost but the browser never fires the `webglcontextrestored` event (a known WebKit bug), a polling mechanism probes for context availability every 2 seconds and automatically restores the 3D scene.

### Test plan

The 3D engine changes can be verified through:
1. Loading the game and checking the title screen 3D showcase renders with correct colours
2. Starting a battle with WebGL enabled — full 3D scene visible
3. Starting a battle with WebGL disabled (e.g., via browser dev tools) — DOM sprites still visible, battle fully playable
4. Triggering a context loss (e.g., via `WEBGL_lose_context` extension) — game falls back to flat mode gracefully
5. Checking memory usage over time — sprite cache evicts old entries
6. Verifying the colour space version-detection works with different Three.js versions

### Future considerations

- **Three.js version upgrade**: The bundled r144 (March 2023) is over two years old. Upgrading to r152+ (or the latest r17x) would simplify the colour-space code to just `outputColorSpace`/`SRGBColorSpace` and bring newer features (improved shadow maps, WebGPU support). The version-agnostic colour-space detection makes this upgrade risk-free.
- **Shadow map quality**: The current 512×512 PCFSoft shadow maps could be increased to 1024×1024 on higher-end devices for crisper shadows, while keeping 512×512 on mobile.
- **Sprite chain timeouts**: The fallback chain walks through up to 5 URLs per sprite with timeouts up to 12 seconds each. On very slow connections, a sprite could take 30+ seconds to fully resolve. Consider progressive timeouts (shorter for static fallbacks).
- **ES module migration**: The IIFE-based architecture prevents tree-shaking. Loading Three.js as an ES module (`three.module.js` or via CDN) could reduce the effective bundle size significantly.
- **WebGPU fallback**: As WebGPU becomes more widely available, a future renderer path could use it instead of WebGL for better performance, especially on Apple Silicon devices.

---

## Appendix B: Full-Codebase Audit Round 2

**Date:** 2026-08-17 · **Scope:** every `src/*.js` module, `index.html`, `sw.js`, `manifest.json`, `tools/`, `assets/css/app.css` — a complete pass over the game beyond the 3D engine (Appendix A).

### Method

- Ran the full quality gate (`npm run check --prefix tools`): ESLint, the 484-check JSDOM smoke suite, and the service-worker revision guard.
- Tried the real-browser Playwright smoke test — browsers cannot be downloaded in this sandbox (the CI workflow documents the same limitation), so it remains a CI-only gate.
- Manually reviewed every module for correctness, escaping, RNG discipline, storage safety, accessibility and dead code.

### Issues found and fixed

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| R1 | **`run._battleCfgJSON` dead field** — written on every battle start but never read anywhere (the resume path uses `run._battleCfg`). It was serialized into every save and every full backup, permanently bloating both. | **MEDIUM** — wasted storage per battle | Removed the write entirely. |
| R2 | **`Storage.available()` never called** — the comment says it "used to warn the player once", but no code path ever calls it. In Safari private mode or a storage-disabled browser the game silently runs without persisting; the player loses everything on refresh with no warning. | **MEDIUM** — silent data loss | Boot now probes `Storage.available()` and shows a one-time toast: "Saves are disabled in this browser — your run will not persist after this session." |
| R3 | **Rect-cache invalidation ordering bug** (from Appendix A) — `_onResize` sets `_hostRectAge=-1` to force an immediate re-measure, but the frame-check `this._hostRectAge++%20===0` post-increments before the `<0` test, so the invalidation was swallowed for up to 20 frames (~330 ms of misaligned sprites after rotation/resize). | **LOW** — brief visual glitch after resize | Reordered: `_hostRectAge<0` is tested before the increment. |
| R4 | **`prefers-reduced-motion` ignored by the 3D engine** — CSS animations were disabled, but the JS-driven scene (idle sprite sway, camera drift, drifting clouds/flies, hit shake) ran continuously, which can disturb vestibular-sensitive players. | **MEDIUM** — accessibility | Added a `REDUCED_MOTION` flag (from `matchMedia`). Ambient motion is zeroed (sprite drift, camera sway, clouds, flies); functional motion (attacks, damage, weather identification) stays; hit shake is softened. |
| R5 | **Deprecated `navigator.platform` in `pwa.js`** — returns empty in cross-origin iframes/hardened browsers, silently disabling the iOS install how-to sheet. | **LOW** — edge-case feature loss | Fallback UA check (`/MacIntel/` + `maxTouchPoints > 1`) added, matching the renderer. |
| R6 | **Stale service-worker shell revision** after source changes | — | Regenerated (`npm run build:sw`); the revision guard now passes. |

### Verified healthy (no change needed)

- **RNG discipline**: `Math.random()` is used only for non-gameplay cosmetics (title animation, music-track pick, AI tie-jitter fallback). All gameplay randomness is seeded (`mulberry32`), persisted (`randState`), and Daily battles are fully deterministic (`dailyBattleSeed` + `dailyAIRand`).
- **Escaping/XSS**: every player-controlled string (nicknames, imported backup names) goes through `escapeHtml`; `profile.avatar` is allow-listed; `data-tip="text:…"` tooltip values are escaped at every call site; imported backups pass `Storage.validate` + sanitizers before touching storage.
- **Storage**: all localStorage access is wrapped in try/catch with graceful degradation; run/profile/daily/audio keys are cleanly separated; migration is versioned and tested.
- **Modal/a11y**: WAI-ARIA dialog pattern, focus trap, `inert` background sync, focus restore — all correct (484-check suite includes ~40 modal/coach interaction tests).
- **PWA**: relative-path SW registration (GitHub Pages subpath safe), bounded caches with LRU eviction, content-hashed shell, self-hosted fonts, offline sprite fallbacks.
- **Battle flow**: identity-mapped engine state (`__tag`), staged start, epoch-guarded async callbacks, debounced battle saves, renderer-loss recovery that preserves the live Showdown streams — all well-guarded.
- **3D engine** (Appendix A): color-space version detection, flat-mode sprite projection, LRU-capped image cache, cached host rect, context-loss polling — all now covered by tests where testable.

### Final state

`npm run check --prefix tools` is fully green: **484/484** JSDOM checks (was 481; +3 new flat-mode renderer tests), 0 ESLint warnings, SW revision current. The real-browser WebGL smoke test remains a CI-only gate (Chromium/SwiftShader) because browsers cannot be downloaded in this sandbox.
