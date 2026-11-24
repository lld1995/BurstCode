// Shared helpers for the script tests: bundle a TypeScript entry the way the
// extension is built (esbuild) and evaluate it in this process, with chosen
// module mocks. Same realm as the test, so strict deep equality just works.
const esbuild = require('esbuild');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

/**
 * Bundle `entry` and return its CommonJS exports. Every own key of `mocks` is
 * left external and resolved to its value; other packages come from the repo.
 */
async function loadTs(entry, mocks = {}) {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: Object.keys(mocks),
    write: false,
    logLevel: 'silent'
  });
  const fromRepo = createRequire(path.join(process.cwd(), 'package.json'));
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module) {\n${built.outputFiles[0].text}\n})`,
    { filename: entry }
  );
  wrapper(module.exports, (name) => (Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : fromRepo(name)), module);
  return module.exports;
}

/**
 * A stand-in for the `vscode` namespace that accepts any use: every property,
 * call and `new` yields another stand-in. Code paths that depend on real
 * configuration must be given a specific mock instead.
 */
function anything() {
  const proxy = new Proxy(function () {}, {
    get(target, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive || key === 'toString') return () => '';
      if (!(key in target)) target[key] = anything();
      return target[key];
    },
    apply: () => anything(),
    construct: () => anything()
  });
  return proxy;
}

/** Run `fn`, resolving to `{ ms, value }` once it has finished. */
async function timed(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, value };
}

module.exports = { loadTs, anything, timed };
