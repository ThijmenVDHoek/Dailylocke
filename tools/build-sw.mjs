// ============================================================================
// build-sw.mjs — stamps sw.js with a content-derived revision.
//
//   node tools/build-sw.mjs          # rewrite SHELL_REV in sw.js
//   node tools/build-sw.mjs --check  # verify it is current (CI / pre-deploy)
//
// WHY
//   The worker used to carry a hand-written `CACHE_NAME = 'dailylocke-v8'`.
//   Cache API entries never expire on their own, so if a deploy changed
//   src/app.js but nobody remembered to bump that number, every returning
//   player kept the OLD JavaScript forever -- the single nastiest class of PWA
//   bug, because it is invisible to the person who shipped it.
//
//   Hashing the actual shell contents removes the human step: change any
//   precached file and the revision changes with it, which names a new cache
//   and lets activate() drop the previous one.
// ============================================================================
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const SW_PATH = resolve(repo, 'sw.js');

const REV_RE = /^const SHELL_REV = '([^']*)';$/m;

// Read the shell list straight out of the worker so the two can never drift.
export function shellFiles(swSource) {
  const block = swSource.match(/const APP_SHELL = \[([\s\S]*?)\]\.map/);
  if (!block) throw new Error('could not find APP_SHELL in sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    .filter((p) => p !== './');          // the directory alias for index.html
}

// One hash over every shell file's bytes, plus the worker's own logic (minus
// the revision line itself, which would otherwise be self-referential).
export function computeRev(swSource) {
  const hash = createHash('sha256');
  for (const rel of shellFiles(swSource).sort()) {
    const abs = resolve(repo, rel);
    if (!existsSync(abs)) {
      // A missing shell entry is a real problem, but it must not break the
      // build here -- install() already tolerates it, and the smoke test is
      // what reports it.
      hash.update(`missing:${rel}`);
      continue;
    }
    hash.update(rel);
    hash.update(readFileSync(abs));
  }
  hash.update(swSource.replace(REV_RE, ''));
  return hash.digest('hex').slice(0, 12);
}

function main() {
  const check = process.argv.includes('--check');
  const source = readFileSync(SW_PATH, 'utf8');
  if (!REV_RE.test(source)) {
    console.error('sw.js has no `const SHELL_REV = \'...\';` line to stamp');
    process.exit(1);
  }
  const rev = computeRev(source);
  const current = source.match(REV_RE)[1];

  if (current === rev) {
    console.log(`sw.js shell revision is current (${rev})`);
    return;
  }
  if (check) {
    console.error(`sw.js shell revision is STALE: ${current} -> ${rev}`);
    console.error('run `npm run build:sw --prefix tools` and commit the result');
    process.exit(1);
  }
  writeFileSync(SW_PATH, source.replace(REV_RE, `const SHELL_REV = '${rev}';`));
  console.log(`sw.js shell revision ${current} -> ${rev}`);
}

// Only run the CLI when invoked directly; the smoke test imports the helpers.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
