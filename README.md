# Dailylocke

A daily endless nuzlocke game, played in the browser. Pick a starter, fight
through sections of wild encounters and trainers, and see how far you get before
your team runs out.

Deployed to GitHub Pages from `main` by `.github/workflows/static.yml`.

## Project layout

```
index.html              markup + script/style tags only (~22 KB)
assets/css/app.css      all UI styling
src/                    game code, loaded in order by index.html
vendor/                 third-party + generated bundles
tools/                  development-only build, lint + test tooling
```

### `src/` — load order matters

Each module is an IIFE that hangs one global off `window`; `index.html` loads
them with `defer`, which keeps document order while staying non-blocking.

| module | global | role |
| --- | --- | --- |
| `pokedata.js` | `PokeData` | capture rates, legendary flags, shop prices |
| `core.js` | `Core` | RNG, type chart, Pokémon factory, catch formula |
| `nuzlocke.js` | `Nuz` | run state, sections, encounters, trainers, mart |
| `evolution.js` | `Evo` | evolution rules and stones |
| `mega.js` | `Mega` | mega evolution |
| `forme.js` | `Forme` | forme changes |
| `itemart.js` | `ItemArt` | item sprites |
| `audio.js` | `GameAudio` | music/SFX volume, battle-only randomised BGM |
| `tooltip.js` | — | move/ability/item tooltips |
| `ui-patch.js` | — | extends `BattleUI` with the run action bar + ball rail |
| `battle.js` | `RogueBattle` | wraps `@pkmn/sim`: HP/status/PP persistence, AI |
| `savecode.js` | `SaveCode` | save-code codec, share links, QR + clipboard helpers |
| `safari-compat.js` | — | iOS viewport quirks |
| `pwa.js` | `PWA` | service worker registration + the install button |
| `app.js` | `Game` | screens, section flow, battle glue — boots the game |

### `vendor/`

| file | notes |
| --- | --- |
| `pkmn-sim.js` | **generated** — battle engine, gen 9 only, no learnsets |
| `pkmn-learnsets.js` | **generated** — gen 9 learnsets, loaded on demand |
| `three.min.js` | three.js r149 |
| `lz-string.min.js` | lz-string 1.5.0 — save-code compression |
| `qrcode.js` | qrcodejs 1.0.0 — QR rendering for share links |
| `battle-ui.js` | hand-written 3D battle renderer — edit directly |

## Installing (PWA)

The game is installable, and `src/pwa.js` owns every part of that.

* **The floating Install pill** sits at the top-left of the title screen,
  opposite Menu. It is inside `#screenTitle`, so it vanishes as soon as a run
  starts — the offer never covers the game.
* **Chrome / Edge / Android:** `beforeinstallprompt` is captured and
  `preventDefault()`ed, which suppresses the browser's own mini-infobar and
  re-offers it on our terms. Tapping the pill calls `prompt()`. The event is
  single-use, so the pill hides after one tap and returns on the next visit if
  the player backed out.
* **iOS / iPadOS, and Safari 17+ on macOS** never fire that event but can still
  install by hand, so there the same pill opens a short how-to sheet
  ("Add to Home Screen" / "Add to Dock") instead.
* **It goes away and stays away.** `appinstalled` and every `display-mode`
  check retire it permanently; the little `x` snoozes it for two weeks in
  `nuzlocke-install`.
* **Nothing here can break the game.** An unsupported browser, a blocked
  service worker, or a `localStorage` that throws (Safari private mode) all
  degrade to "no button".

### Paths must stay relative

This deploys to a GitHub Pages **project** site
(`https://<user>.github.io/Dailylocke/`), not a root domain. Root-absolute URLs
like `/manifest.json` or `/sw.js` resolve to the *user* site and 404 there,
which silently makes the app un-installable: no manifest, no worker, so
`beforeinstallprompt` never fires. Accordingly the manifest link, its
`start_url` / `scope` / icons, the `register('sw.js')` call and every
`APP_SHELL` entry are relative, and the smoke test guards each of them.

The worker also precaches with `cache.add()` per file rather than `addAll()`,
because `addAll()` is atomic — one 404 would reject `install()` and leave the
app permanently offline-less.

## Save transfer (Save Codes)

Runs persist to `localStorage` automatically, and can hop between devices
with **no server and no accounts**: every battle/section finish screen has a
**Save progress** button, and the Menu offers *Transfer save* / *Import save*.

* The run state is serialised by `saveGameState()` (one central function,
  same snapshot autosave writes), compressed with
  `LZString.compressToEncodedURIComponent()`, and offered three ways:
  * **Save Code** — copy/paste text for the *Import save* box.
  * **Share link** — `https://<origin>/<path>?save=<code>`.
  * **QR code** — encodes the exact share link, so a phone camera opens it
    directly.
* Opening a `?save=…` link auto-imports on page load (decompress → schema
  validate → `loadGameState()` → migrate → `localStorage`), then strips the
  param with `history.replaceState()` so refreshes don't re-import. A
  pre-existing run is never replaced without a confirm.
* Import never crashes on junk: garbage codes, truncated links, foreign JSON,
  saves newer than the game and empty parties are all rejected with a friendly
  message, and the battle log is dropped from exports so long runs still fit
  in one QR (error-correction level steps down H→M→Q→L as needed).

## Audio

`src/audio.js` owns every sound. Two sliders live in **Menu → Profile → Sound**
and persist to their own `nuzlocke-audio` key, separate from the profile so a
device preference never rides along with synced shinies and run history.

* **Sliders are perceptual.** Gain is `slider²` — a linear slider spends most
  of its travel in the "far too loud" range. Music defaults to `0.35`
  (≈0.12 gain); it used to be a flat `1.0` in battle and `0.5` everywhere else.
* **Music only plays in battle.** `beginBattle()` starts a track and `show()`
  fades it out on every other screen. Nothing observes the DOM.
* **Tracks are randomised per battle**, drawn from a pool that matches the
  fight: rival/villain themes for wilds, trainer themes for trainers, and
  `spl-elite4` / `bw2-kanto-gym-leader` held back for boss trainers. The
  previous track never repeats back-to-back. Selection uses `Math.random`, not
  the run's seeded RNG — picking a song must not desync the daily run.

## Loading strategy

The whole game used to be one 12 MB `index.html`. Every byte of it — including
five megabytes of learnset tables and nine unused generations of Pokémon data —
had to be parsed before anything appeared on screen.

Now:

* **gen 9 only.** The game hardcodes the `gen9customgame` format and never
  builds a modded dex, so gens 1–8 and Pokémon GO data are stubbed out of the
  bundle at build time.
* **learnsets are split out.** They're only read behind `Core.legalMoves()`,
  which was already `async`, so they ship as a separate chunk that `app.js`
  prefetches during the title screen. `PS.learnsetsReady()` is awaited before
  any learnset read, so a slow download delays a moveset roll instead of
  producing an empty one.
* **nothing blocks paint.** CSS is a real stylesheet, scripts are `defer`, and
  the sprite/audio origins are `preconnect`ed.

| | raw | gzipped |
| --- | --- | --- |
| old single file | 12.06 MB | 1.57 MB |
| critical path (to first battle) | 3.36 MB | 0.75 MB |
| deferred learnsets chunk | 3.03 MB | 0.39 MB |

## Development

The game itself is static — serve the repo root and open it:

```sh
python3 -m http.server 8000
```

The development tools require Node.js 22.22.2 or newer.

### Rebuilding the engine bundles

Only needed when bumping `@pkmn/sim`:

```sh
cd tools
npm install
npm run build     # regenerates vendor/pkmn-sim.js + vendor/pkmn-learnsets.js
```

### Quality checks

`tools/smoke-test.mjs` loads `index.html` in JSDOM using the real script order,
then boots the game and fights an actual battle through the engine. It checks
module wiring, that the trimmed bundle kept its data, that learnsets load on
demand, that the install button appears/prompts/retires correctly on every
platform path, that the PWA paths stay subpath-safe, and that the battle
reaches a conclusion. ESLint covers the hand-written JavaScript and catches
unused code as part of the same command.

```sh
npm ci --prefix tools
npm run check --prefix tools
```

## Third-party software and assets

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled software
licenses, remote asset credits, and the fan-project disclaimer. The repository
does not currently declare a project-level license for Dailylocke's own code.
