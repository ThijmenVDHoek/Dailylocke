import { createRequire } from 'node:module';

// Development dependencies live in tools/ so the deployable app stays static.
const require = createRequire(new URL('./tools/package.json', import.meta.url));
const js = require('@eslint/js');
const globals = require('globals');

const projectRules = {
  ...js.configs.recommended.rules,
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': ['error', {
    args: 'after-used',
    caughtErrors: 'none',
  }],
  'no-useless-assignment': 'error',
};

export default [
  {
    // tools/e2e/run.mjs passes functions to page.evaluate(), which run inside
    // the BROWSER, so those bodies legitimately reference browser globals.
    files: ['tools/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...projectRules, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    ignores: [
      'tools/node_modules/**',
      'vendor/pkmn-learnsets.js',
      'vendor/pkmn-sim.js',
      'vendor/three.min.js',
    ],
  },
  {
    files: ['src/**/*.js', 'vendor/battle-ui.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: projectRules,
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: projectRules,
  },
  {
    files: ['tools/**/*.mjs', 'tools/e2e/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: projectRules,
  },
];
