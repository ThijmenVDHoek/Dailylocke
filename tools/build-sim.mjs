// ============================================================================
// build-sim.mjs — produces the two @pkmn/sim bundles the game loads.
//
//   vendor/pkmn-sim.js        core engine + gen9 data, NO learnsets  (~2.2 MB)
//   vendor/pkmn-learnsets.js  gen9 learnsets, fetched on demand      (~3 MB)
//
// The stock @pkmn/sim browser bundle is 10.7 MB because it statically pulls in
// every generation's data tables. This game only ever runs `gen9customgame`,
// and it only touches learnsets when it needs to roll a moveset — which is
// always behind an `await`. So we:
//
//   * stub out gen1-gen8 mod data (the game never calls Dex.forGen/Dex.mod)
//   * stub out Pokemon GO data (unused)
//   * split learnsets into their own chunk that loads in the background
//
// Run `npm install && npm run build` in this directory after bumping @pkmn/sim.
// ============================================================================
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { mkdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const outDir = resolve(repo, 'vendor');
mkdirSync(outDir, { recursive: true });

// @pkmn/sim's package `exports` map hides its internals, so the learnsets
// chunk imports the data modules by absolute path instead of subpath.
const SIM_DATA = resolve(here, 'node_modules/@pkmn/sim/build/esm/data');
for (const f of ['learnsets.mjs', 'legality.mjs']) {
  if (!existsSync(resolve(SIM_DATA, f))) {
    console.error(`missing ${resolve(SIM_DATA, f)} — run \`npm install\` in tools/ first`);
    process.exit(1);
  }
}
const asImport = (p) => JSON.stringify(p.replace(/\\/g, '/'));

// --------------------------------------------------------------- stubbing --
// Replace a module with a hand-written source string, matched on a path
// fragment so it works regardless of how npm hoisted the package.
function stubPlugin(stubs) {
  return {
    name: 'stub',
    setup(build) {
      build.onLoad({ filter: /@pkmn[\\/]sim[\\/]build[\\/]esm[\\/].*\.mjs$/ }, (args) => {
        const rel = args.path.replace(/\\/g, '/').split('/build/esm/')[1];
        const contents = stubs[rel];
        if (contents === undefined) return null;
        return { contents, loader: 'js' };
      });
    },
  };
}

const EMPTY_LEARNSETS = 'export const Learnsets = {};\n';
const EMPTY_LEGALITY = 'export const Legality = {};\n';

// Every generation except 9 is dead weight: the game hardcodes the
// `gen9customgame` format and never constructs a modded dex.
const MOD_IDS = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8', 'gen8bdsp', 'gen8legends'];

const coreStubs = {
  'data/learnsets.mjs': EMPTY_LEARNSETS,
  'data/legality.mjs': EMPTY_LEGALITY,
  'data/pokemongo.mjs': 'export const PokemonGoData = {};\n',
};
for (const mod of MOD_IDS) {
  // The mod index re-exports the whole table set; an empty object is a valid
  // (never-consulted) entry in dex.mjs's `dexData` map.
  coreStubs[`data/mods/${mod}/index.mjs`] = 'export default {};\n';
  coreStubs[`data/mods/${mod}/learnsets.mjs`] = EMPTY_LEARNSETS;
  coreStubs[`data/mods/${mod}/legality.mjs`] = EMPTY_LEGALITY;
}

// ------------------------------------------------------------ core bundle --
const CORE_ENTRY = `
import { Dex, Teams, BattleStreams, toID } from '@pkmn/sim';

// The engine reads a global \`Config\` on some code paths.
if (typeof globalThis.Config === 'undefined') globalThis.Config = {};

// Learnsets are shipped separately (see vendor/pkmn-learnsets.js) and injected
// here once they arrive. \`Dex.data.Learnsets\` starts out as an empty table, so
// anything that reads it before the chunk lands must go through
// \`PS.learnsetsReady()\` first — \`Dex.learnsets.get()\` is already async, which
// is what makes this split invisible to callers.
let learnsetsPromise = null;

function injectLearnsets(table) {
  Object.assign(Dex.data.Learnsets, table);
  // DexLearnsets memoises misses as "doesn't exist", so drop anything cached
  // from before the real table arrived.
  if (Dex.learnsets && Dex.learnsets.learnsetCache) Dex.learnsets.learnsetCache.clear();
  return table;
}

function loadLearnsets(src) {
  if (learnsetsPromise) return learnsetsPromise;
  if (globalThis.__PS_LEARNSETS) {
    learnsetsPromise = Promise.resolve(injectLearnsets(globalThis.__PS_LEARNSETS));
    return learnsetsPromise;
  }
  learnsetsPromise = new Promise((res, rej) => {
    const url = src || (globalThis.__PS_LEARNSETS_URL || 'vendor/pkmn-learnsets.js');
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => {
      if (!globalThis.__PS_LEARNSETS) return rej(new Error('learnsets chunk loaded but empty'));
      res(injectLearnsets(globalThis.__PS_LEARNSETS));
    };
    el.onerror = () => rej(new Error('failed to load ' + url));
    document.head.appendChild(el);
  }).catch((err) => {
    // Let a later call retry rather than poisoning the game forever.
    learnsetsPromise = null;
    throw err;
  });
  return learnsetsPromise;
}

globalThis.PS = {
  Dex, Teams, BattleStreams, toID,
  learnsetsReady: loadLearnsets,
  get learnsetsLoaded() { return Object.keys(Dex.data.Learnsets).length > 0; },
};
`;

// ------------------------------------------------------- learnsets bundle --
// Mirrors the merge dex.mjs performs for gen9 so the split table is identical
// to the one the stock bundle would have built.
const LEARNSETS_ENTRY = `
import { Learnsets } from ${asImport(resolve(SIM_DATA, 'learnsets.mjs'))};
import { Legality } from ${asImport(resolve(SIM_DATA, 'legality.mjs'))};

const LEARN_ORDER = 'MTLREVDSC';
const merged = { ...Learnsets };
for (const id in Legality) {
  for (const key in Legality[id]) {
    if (!merged[id]) merged[id] = {};
    if (key === 'learnset') {
      const existing = merged[id].learnset || (merged[id].learnset = {});
      for (const moveid in Legality[id][key]) {
        const special = Legality[id][key][moveid];
        if (existing[moveid]) {
          existing[moveid].push(...special);
          existing[moveid].sort((a, b) =>
            +b.charAt(0) - +a.charAt(0) ||
            LEARN_ORDER.indexOf(a.charAt(1)) - LEARN_ORDER.indexOf(b.charAt(1)));
        } else {
          existing[moveid] = special;
        }
      }
    } else {
      merged[id][key] = Legality[id][key];
    }
  }
}
globalThis.__PS_LEARNSETS = merged;
`;

const shared = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: here,
};

function report(file) {
  const bytes = statSync(file).size;
  const gz = gzipSync(readFileSync(file)).length;
  console.log(
    `  ${relative(repo, file).padEnd(28)} ${(bytes / 1048576).toFixed(2)} MB` +
    `  (${(gz / 1048576).toFixed(2)} MB gzipped)`);
}

console.log('building @pkmn/sim bundles...');

await esbuild.build({
  ...shared,
  stdin: { contents: CORE_ENTRY, resolveDir: here, sourcefile: 'sim-core.mjs', loader: 'js' },
  plugins: [stubPlugin(coreStubs)],
  outfile: resolve(outDir, 'pkmn-sim.js'),
  minify: true,
});

await esbuild.build({
  ...shared,
  stdin: { contents: LEARNSETS_ENTRY, resolveDir: here, sourcefile: 'sim-learnsets.mjs', loader: 'js' },
  outfile: resolve(outDir, 'pkmn-learnsets.js'),
  minify: true,
});

report(resolve(outDir, 'pkmn-sim.js'));
report(resolve(outDir, 'pkmn-learnsets.js'));

console.log('done.');
