/**
 * Preload script: register vscode mock into Node's module loader
 * before any test file imports it.
 */
import * as path from 'path';
import Module from 'module';

const mockPath = path.resolve(__dirname, 'vscode-mock.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mock = require(mockPath);

const moduleWithLoad = Module as unknown as { _load: (...args: unknown[]) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function patchedLoad(...args: unknown[]) {
  if (args[0] === 'vscode') return mock;
  return originalLoad.apply(this, args);
};
