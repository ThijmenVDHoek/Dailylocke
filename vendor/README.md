# vendor/

Generated files — do not edit by hand (except `battle-ui.js`, see below).
License texts and asset credits are collected in `../THIRD_PARTY_NOTICES.md`.

| file | source |
| --- | --- |
| `pkmn-sim.js` | `tools/build-sim.mjs` (@pkmn/sim, gen9 only, learnsets split out) |
| `pkmn-learnsets.js` | `tools/build-sim.mjs` (gen9 learnsets, loaded on demand) |
| `three.min.js` | three.js r149 UMD build |
| `battle-ui.js` | hand-written 3D battle renderer (edit this one directly) |

Rebuild the @pkmn/sim bundles with:

```sh
cd tools && npm install && npm run build
```
