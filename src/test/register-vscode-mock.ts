/**
 * Preload script: register vscode mock into Node's module cache
 * before any test file imports it.
 * Usage: node --require ./out/test/register-vscode-mock.js ...
 */
import * as path from 'path';

// Register the mock under the name 'vscode' in require.cache
// so that subsequent require('vscode') hits the cache.
const mockPath = path.resolve(__dirname, 'vscode-mock.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mock = require(mockPath);

// Node resolves 'vscode' to a special virtual path in extension host.
// Outside extension host there is no real vscode module; we inject ours
// into the cache under every plausible key that require('vscode') might resolve to.
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  parent: null,
  children: [],
  paths: [],
  exports: mock,
} as unknown as NodeJS.Module;
