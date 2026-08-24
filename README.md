# Dailylocke

A daily nuzlocke challenge, played in the browser. Pick a starter, fight through
sections of wild encounters and trainers, and try to keep your team alive.

Three modes, **independent save slots** — so one can never block another:

| | **Daily** | **Free Play** | **Team Gauntlet** |
| --- | --- | --- | --- |
| challenge | the same for everyone on that date | randomized each run | trainers only, no wilds |
| team | catch as you go | catch as you go | **draft any 6 Pokemon, free** |
| length | **5 sections** (20 battles), then it ends | endless | endless trainer rush |
| rules | — | — | no cash, no items, no running; heal after every win |
| ending | scored, recorded, and shareable | runs until your last Pokemon falls | runs until your last Pokemon falls |
| slot | `dailylocke-run-daily` | `nuzlocke-run` | `dailylocke-run-gauntlet` |

In the Gauntlet, trainer N is exactly as hard as the Nth trainer battle of a
Daily or Free Play run — both funnel through the same difficulty pipeline
(`Nuz.tier` / `trainerFor` / `makeTrainerTeam`, keyed on the section counter),
so battle 2 or battle 10 lands on the same challenge everywhere, ascension
included.

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
| `core.js` | `Core` | RNG, type chart, Pokémon factory, role-based movesets, catch formula |
| `storage.js` | `Storage` | every `localStorage` access, the slot layout, save migrations |
| `modal.js` | `Modal` | one dialog controller for every overlay (WAI modal pattern) |
| `daily.js` | `Daily` | the dated Daily challenge: day keys, streaks, calendar, share card |
| `nuzlocke.js` | `Nuz` | run state, sections, encounters, trainers, mart, ascension |
| `evolution.js` | `Evo` | evolution rules and stones |
| `mega.js` | `Mega` | mega evolution |
| `forme.js` | `Forme` | forme changes |
| `itemart.js` | `ItemArt` | item sprites |
| `coach.js` | `Coach` | plain-language move/item facts (STAB, drawbacks, good-fit) |
| `audio.js` | `GameAudio` | music/SFX volume, battle-only randomised BGM |
| `champions-loader.js` | `ChampionsLearnsetsReady` | lazy optional Champions move-pool loader |
| `renderer-loader.js` | `RendererReady` | post-paint Three/BattleUI upgrade |
| `app-loader.js` | `AppReady` | post-paint game-controller loader |
| `tooltip.js` | — | move/ability/item tooltips |
| `ui-patch.js` | — | extends `BattleUI` with the run action bar + ball rail |
| `battle.js` | `RogueBattle` | wraps `@pkmn/sim`: HP/status/PP persistence, situational AI |
| `savecode.js` | `SaveCode` | full-account backup files (plain JSON, validated on import) |
| `safari-compat.js` | — | iOS viewport quirks |
| `pwa.js` | `PWA` | service worker registration + the install button |
| `app.js` | `Game` | screens, section flow, battle glue — boots the game |

### `vendor/`

| file | notes |
| --- | --- |
| `pkmn-sim.js` | **generated** — battle engine, gen 9 only, no learnsets |
| `pkmn-learnsets.js` | **generated** — gen 9 learnsets, loaded on demand |
| `three.min.js` | three.js r149 |
| `battle-ui.js` | hand-written 3D battle renderer — edit directly |

## Themes

19 themes (the 18 Pokémon types plus Default), chosen under **Menu → Profile**.
Every theme recolours the *whole* UI, not just the page background: the theme
seeds three background steps plus its accent colours, and `applyTheme()` in
`src/app.js` derives the complete palette from them (surfaces, inks, tracks,
danger red, CTA text contrast). The theme is applied at boot from the saved
profile, so it is live before the first paint of every session, and the
battlefield's "Match theme" mode maps each theme to its own 3D biome.

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

## Plain-language clarity

Dailylocke runs a competitive engine under the hood: real Showdown movesets,
held items, natures, EVs, eight ball types and thirteen medicines. To keep
that depth legible without a manual, the UI always surfaces a few plain facts
on the cards the player is already reading. They are never popups and never
need dismissing — they are part of the layout.

* Every move list — starter cards, party sheet, training — carries a **STAB**
  badge, a *weak stat* marker when the move uses the Pokémon's lesser attacking
  stat, and a red chip for the traps (`Must rest after`, `Charges first`,
  `Locks you in`, `Hurts you`, `Often misses`, `Always moves last`).
* Confusing items get an honest one-liner under their canon name. **Full Heal**
  is the worst offender: it cures status and restores *zero HP*, and it sits in
  the shop directly beside Full Restore, which does both.
* In the Mart, a held item that genuinely suits someone in the party is tagged
  *✦ Good fit*, so a recommendation appears only when it actually applies.

These live in [`src/coach.js`](src/coach.js) (`window.Coach`): the
plain-language move/item facts. A new player opens the game straight to the
mode menu (Daily / Random Run / Gauntlet); a first-time visitor is first asked
to pick a trainer sprite and name, then lands on that menu.

## Full-game backups

The game autosaves active runs to browser storage. The Menu's **Transfer save**
and **Import save** options provide a single, straightforward recovery and
cross-device flow:

1. Choose **Transfer save** and download the backup file.
2. Move the file to the other device (or keep it somewhere safe).
3. On that device choose **Import save**, select the file, and restore it.

Each backup is a complete account state: Daily, Free Play and Gauntlet slots;
avatar and theme; Shiny Collection; run history and career; and the Daily
record/streak. Restoring deliberately replaces the saved state on the current
device, avoiding ambiguous partial merges.

Backups are **plain JSON** — there is deliberately no password or encryption.
They protect against losing a device, not against someone who gets hold of the
file, so treat a backup like you would any other save file of an online
account. Every value in an imported file is validated and sanitized before it
touches browser storage, and anything malformed is rejected wholesale with a
clear message rather than partially applied. Share URLs and QR transfers are
intentionally not supported.

As with any entirely client-side game, browser state is not
server-authoritative: durable anti-cheat for competitive scores would require
server-side validation and a secret held off the client.

## The Daily

The Daily used to be an ordinary endless run tied to the current date while
sharing the single save slot with everything else. That meant a *good* run
locked you out of tomorrow's Daily unless you threw it away — the opposite of
what a daily should do.

* **It is finite.** Five sections, twenty battles. Clearing section 5 completes
  it; losing your last Pokemon ends it early. Either way it is recorded once.
* **It has its own slot.** `dailylocke-run-daily`, separate from Free Play. Both
  can be in progress at the same time and the title offers whichever exist.
* **Dates are local.** `Daily.dayKey()` formats the player's own calendar date;
  it never uses `toISOString()`, which is UTC and would hand someone in UTC+13 a
  different "today" than their phone shows.
* **Battles are deterministic.** Crits, misses and damage rolls are identical
  for everyone playing that day's challenge. Free Play keeps the engine's own
  randomness.
* **Yesterday is never destroyed.** An unfinished Daily from a previous day is
  offered as *Move old Daily to Free Play*; a cleared Daily can carry its
  surviving team into Free Play. A wipe ends immediately with no continuation.
* **Streaks are forgiving.** Missing one day keeps the streak (and burns a grace
  day); missing two resets it. Every clean week earns the grace day back. The
  streak is recomputed against today rather than trusted from storage, so it
  can't go stale. Stored in `dailylocke-daily`, a key no run wipe touches.

The share card is deliberately spoiler-light — it shows the *shape* of a run,
never which Pokémon appeared:

```text
Dailylocke #142
Sections: 5/5
Battles: 20
Caught: 3
Lost: 0
MVP: Gengar
🟩🟩🟥🟩🟩
```

One square per section: 🟩 nobody fell · 🟨 survived but bruised · 🟥 lost a
Pokémon · ⬛ the section that ended the run.

## Ascension — difficulty past section 15

The rules said sections "scale forever", but almost every lever hit its ceiling
around section 10–15: BST bands stopped widening, EV investment maxed out, teams
capped at six, legendaries were already unlocked. Meanwhile battle rewards kept
compounding at +10% per win — about **7×** by section 30. The run got richer
while it stopped getting harder.

Past section 15, each further block of five sections adds one **ascension tier**
of *qualitative* difficulty instead of bigger numbers:

| tier | what turns on |
| --- | --- |
| 1 | battle-start weather / terrain / hazards / rooms; boss clauses every 5 sections |
| 2 | elite Pokémon with one visible modifier; role-appropriate held items; legendary wilds |
| 3+ | reduced section healing (down to 55%); deeper trainer AI |

Rewards are bent onto a bounded curve at the same time: the first dozen wins keep
the old snappy +10% ramp, then payouts grow with `sqrt(wins)` and cap at 4.5×.

**Nothing here is hidden.** The route screen previews the ascension tier, the
field effect the battle will open with, the boss clause, and the trainer's
strategy before you commit to the fight.

## Team roles and the AI

Generated movesets used to be four damaging attacks on everything, which made
most Pokémon play the same. Sets are now built around a **role** — sweeper,
wall, pivot, disruptor, weather, hazard lead, priority — which reserves slots for
recovery, setup, or utility. STAB is always mandatory, so a set never loses its
identity, and the role is filtered by what the species can actually do (a Shuckle
is not asked to sweep; a Deoxys-Attack is not asked to wall).

The enemy AI used to give *every* status move a flat score of 12–20, so it would
happily re-apply a status the target already had, Thunder Wave a Ground type, set
up on the turn it was about to be knocked out, or heal at full HP. It now scores
against the real board: current HP on both sides, existing status, stat boosts,
the speed race, type *and* status immunities, hazards already up, and how close
the target is to fainting. Ascension raises `aiDepth`, so early trainers stay
beatable while late ones look further ahead.

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
  the run's deterministic RNG — picking a song must not desync the daily run.

## Splitting `app.js`

`app.js` did everything: screens, profile data, saves, battle protocol, catches,
rewards, animations and event binding. It is being broken up **incrementally** —
a framework rewrite is unnecessary and would risk the whole game at once.

The plan, in order of least-entangled first:

1. ~~persistence and migrations~~ → **`src/storage.js`** ✅
2. ~~the Daily's own state~~ → **`src/daily.js`** ✅
3. ~~modal/dialog behaviour~~ → **`src/modal.js`** ✅
4. profile/history rendering
5. battle protocol rendering
6. screen controllers
7. ES modules, and only then a bundler

Each step keeps the old function names in `app.js` as thin delegates, so callers
don't move in the same commit that the logic does. `app.js` is currently about
369 KB raw; the next split targets the profile/history renderer, battle protocol,
and screen controllers rather than pretending the old size claim is still true.
The extracted modules remain independently unit-tested.

## Loading strategy

The whole game used to be one 12 MB `index.html`. Every byte of it — including
five megabytes of learnset tables and nine unused generations of Pokémon data —
had to be parsed before anything appeared on screen.

Now:

* **gen 9 only.** The game hardcodes the `gen9customgame` format and never
  builds a modded dex, so gens 1–8 and Pokémon GO data are stubbed out of the
  bundle at build time.
* **learnsets are split out.** The 3 MB Showdown learnset table is only read
  behind `Core.legalMoves()`, which was already `async`. The Champions
  supplement is lazy-loaded by the same pattern, so neither table is parsed on
  the title path. Both loaders are awaited before a move pool is built, so a
  slow download delays a moveset roll instead of producing an empty one.
* **The battlefield always has depth.** Every title/battle scene includes a
  layered CSS perspective environment—sky, distant terrain, ground plane,
  platforms, weather, terrain and room effects—plus projected DOM Pokémon.
  WebGL is now an optional enhancement painted over that complete environment,
  never the only environment. The title renders the same 3D biome as a battle
  through the one shared renderer, and either scene seamlessly reveals the CSS
  environment if the browser refuses or loses its GPU context while renderer
  recovery continues in the background. Recovery is bounded: replaced
  renderers force-release their GL context immediately (never stacking live
  contexts against the browser's per-origin budget), and a browser report of
  an exhausted context budget stands the background chain down instead of
  thrashing the GPU process.
* **nothing blocks paint.** CSS is a real stylesheet, scripts are `defer`, and
  the sprite/audio origins are `preconnect`ed.

| | raw | gzipped |
| --- | --- | --- |
| old single file | 12.06 MB | 1.57 MB |
| critical path (to first paint) | 2.75 MB | 0.60 MB |
| optional 3D renderer (post-paint) | 0.73 MB | 0.19 MB |
| optional game controller (post-paint) | 0.37 MB | 0.11 MB |
| lazy Champions supplement | 0.20 MB | 0.02 MB |
| deferred gen 9 learnsets | 3.03 MB | 0.39 MB |

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

One suite, one gate.

**`tools/smoke-test.mjs` (JSDOM)** loads `index.html` using the real script
order, boots the game and fights an actual battle through the engine. It covers
module wiring, the trimmed bundle's data, on-demand learnsets, the install
button on every platform path, subpath-safe PWA paths, backup export/import
round-tripping (including rejection of malformed files), the Daily's
date/streak/share logic, the ascension curve, role-based movesets, the AI's
situational scoring, the modal controller and the plain-language badges.

A real-browser Playwright check now covers the gap JSDOM cannot: Chromium with
SwiftShader loads the deployed app, verifies the singleton renderer, exercises
context loss/restoration and confirms the DOM HUD survives flat mode. It lives
in `tools/browser-smoke.mjs` and is intentionally small so it can run on CI.

```sh
npm ci --prefix tools
npm run check --prefix tools        # lint + JSDOM + service-worker revision
npm run test:browser --prefix tools # requires a Playwright browser install
```

### CI

The active workflow is
[`/.github/workflows/check.yml`](.github/workflows/check.yml). It runs on every
push and pull request, installs Chromium for the WebGL smoke test, and gates the
Pages deploy. `static.yml` runs the same quality gate before uploading the Pages
artifact, so a stale service-worker revision or broken renderer cannot silently
ship on `main`.

### The service-worker revision

`sw.js` names its cache `dailylocke-shell-<rev>`, where `rev` is a hash of the
precached files' contents, stamped by `tools/build-sw.mjs`.

This replaced a hand-written `CACHE_NAME = 'dailylocke-v8'`. Cache API entries
never expire on their own, so if a deploy changed `src/app.js` but nobody
remembered to bump that number, every returning player kept the **old
JavaScript forever** — invisible to whoever shipped it. Hashing the contents
removes the human step.

```sh
npm run build:sw --prefix tools     # restamp after changing a shell file
node tools/build-sw.mjs --check     # CI guard; part of `npm run check`
```

## Offline

The app shell works offline, and so does everything the UI's *shape* depends on.

* **VT323 is self-hosted** (`assets/fonts/`, ~34 KB across two subsets). It used
  to come from Google Fonts, which a service worker cannot precache
  cross-origin, so an offline launch silently fell back to Courier and the whole
  UI changed shape.
* **A bundled SVG fallback** terminates every sprite chain, so a missing sprite
  is a silhouette in the game's own palette rather than a broken-image glyph.
* **Runtime caches are bounded and separate.** Remote sprites (240 entries) and
  cries (60) each get their own cache with oldest-first eviction. The sprite
  catalogue is thousands of files and the audio catalogue is hundreds of
  megabytes; neither is ever precached wholesale, because a quota eviction would
  take the app shell with it.
* **`manifest.json` ships narrow + wide screenshots**, which browsers use to
  show a richer, app-store-like install dialog. The screenshots are committed
  assets (`assets/screenshots/`), captured from the real app.

## Pokémon Champions

The Stat Point system (66 total, 32 per stat) is **Dailylocke's own** simplified
front-end for EVs — a 66-point budget is something you can reason about on a
phone, where "508 EVs in multiples of 4" is not. Training edits a session draft,
so any slider can move first; an over-budget draft must be corrected before
leaving and is never written into the live run or a save. It is not a claim of
Pokémon Champions compatibility: battles run through `gen9customgame` on `@pkmn/sim`,
and player-facing wording says so. If the simulator package later exposes
everything a Champions format needs, that's a deliberate migration, not an
assumption baked into the copy today.

## License

Dailylocke's own code is [MIT licensed](LICENSE).

That covers `src/`, `assets/`, `tools/`, `sw.js`, `index.html` and
`vendor/battle-ui.js` only. It does **not** cover bundled third-party software
in `vendor/` (each keeps its own license) or any Pokémon property fetched at
runtime. Pokémon and all related media are © Nintendo / Creatures Inc. / GAME
FREAK inc.; this is an unofficial, non-commercial fan project.

Note that the PokeAPI sprites repository is distributed under CC0 while noting
that the image *contents* remain copyright The Pokémon Company — a permissive
repository license is not a license to the artwork. **Get your own legal advice
before monetizing this or shipping it to an app store.**

## Third-party software and assets

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled software
licenses, remote asset credits, and the fan-project disclaimer.
