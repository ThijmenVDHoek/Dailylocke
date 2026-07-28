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
    varsIgnorePattern: '^QRCode$',
  }],
  'no-useless-assignment': 'error',
};

export default [
  {
    ignores: [
      'tools/node_modules/**',
      'vendor/lz-string.min.js',
      'vendor/pkmn-learnsets.js',
      'vendor/pkmn-sim.js',
      'vendor/qrcode.js',
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
    files: ['tools/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: projectRules,
  },
];
