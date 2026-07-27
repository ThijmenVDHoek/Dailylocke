# Dailylocke

A daily endless nuzlocke game, played in the browser. Pick a starter, fight
through sections of wild encounters and trainers, and see how far you get before
your team runs out.

Deployed to GitHub Pages from `main` by `.github/workflows/static.yml`.

## Project layout

```
index.html              markup + script/style tags only (~16 KB)
assets/css/app.css      all UI styling
src/                    game code, loaded in order by index.html
vendor/                 third-party + generated bundles
tools/                  build + test tooling (not deployed)
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
| `tooltip.js` | — | move/ability/item tooltips |
| `battle.js` | `RogueBattle` | wraps `@pkmn/sim`: HP/status/PP persistence, AI |
| `safari-compat.js` | — | iOS viewport quirks |
| `app.js` | `Game` | screens, section flow, battle glue — boots the game |

### `vendor/`

| file | notes |
| --- | --- |
| `pkmn-sim.js` | **generated** — battle engine, gen 9 only, no learnsets |
| `pkmn-learnsets.js` | **generated** — gen 9 learnsets, loaded on demand |
| `three.min.js` | three.js r149 |
| `battle-ui.js` | hand-written 3D battle renderer — edit directly |

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

Everything is static — serve the repo root and open it:

```sh
python3 -m http.server 8000
```

### Rebuilding the engine bundles

Only needed when bumping `@pkmn/sim`:

```sh
cd tools
npm install
npm run build     # regenerates vendor/pkmn-sim.js + vendor/pkmn-learnsets.js
```

### Tests

`tools/smoke-test.mjs` loads `index.html` in JSDOM using the real script order,
then boots the game and fights an actual battle through the engine. It checks
module wiring, that the trimmed bundle kept its data, that learnsets load on
demand, and that the battle reaches a conclusion.

```sh
npm --prefix tools install     # or: npm i -g jsdom
node tools/smoke-test.mjs
```
