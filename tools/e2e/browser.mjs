// ============================================================================
// browser.mjs — locate a Chromium for the Playwright suite.
//
// Playwright normally downloads its own browser into ~/.cache/ms-playwright,
// so that is tried FIRST. CI images and sandboxes often can't reach the
// Playwright CDN though, so we also accept:
//
//   DAILYLOCKE_CHROMIUM=/path/to/chromium   explicit override
//   a system chromium/chrome on PATH
//
// If none of those exist the suite SKIPS rather than fails: a developer
// without a browser installed should still be able to run `npm run check`.
// ============================================================================
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

function onPath(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// Returns { executablePath, source } or null when no browser is available.
// `executablePath: undefined` means "use Playwright's own managed download".
export function findBrowser() {
  const override = process.env.DAILYLOCKE_CHROMIUM;
  if (override && existsSync(override)) {
    return { executablePath: override, source: 'DAILYLOCKE_CHROMIUM' };
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return { executablePath: undefined, source: 'playwright' };
  } catch { /* browsers were never downloaded */ }

  for (const c of CANDIDATES) if (existsSync(c)) return { executablePath: c, source: c };
  for (const n of ['chromium', 'chromium-browser', 'google-chrome']) {
    const p = onPath(n);
    if (p) return { executablePath: p, source: p };
  }
  return null;
}

// Launch flags that make Chromium work in a container: no sandbox (no user
// namespaces available), no /dev/shm reliance, and software GL so the game's
// WebGL battle renderer actually initialises instead of failing to create a
// context -- which is precisely the thing JSDOM could never test.
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
];
