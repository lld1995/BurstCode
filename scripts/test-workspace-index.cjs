// The workspace outline must not be rebuilt for changes it cannot show. Each
// rebuild is awaited by the next prompt before its request goes out, and
// BurstCode itself writes a checkpoint into the hidden `.burstcode/` directory
// of the workspace on every prompt.
// Run: node scripts/test-workspace-index.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadTs } = require('./testkit.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Just enough of the `vscode` namespace for WorkspaceIndex, with hooks to fire its events. */
function vscodeMock(root) {
  const fired = { create: [], delete: [], createFiles: [], deleteFiles: [], renameFiles: [] };
  const on = (list) => (fn) => { list.push(fn); return { dispose() {} }; };
  class VscodeEmitter {
    constructor() { this.inner = new EventEmitter(); this.event = (fn) => { this.inner.on('fire', fn); return { dispose() {} }; }; }
    fire(value) { this.inner.emit('fire', value); }
    dispose() {}
  }
  const watcher = { onDidCreate: on(fired.create), onDidDelete: on(fired.delete), dispose() {} };
  const folder = { uri: { fsPath: root, toString: () => 'file:///ws' } };
  const fire = (list, ...fsPaths) => list.forEach((fn) => fsPaths.forEach((p) => fn({ fsPath: p, uri: { fsPath: p } })));
  return {
    fireCreate: (...p) => fire(fired.create, ...p),
    fireDelete: (...p) => fire(fired.delete, ...p),
    fireCreateFiles: (...p) => fired.createFiles.forEach((fn) => fn({ files: p.map((fsPath) => ({ fsPath, uri: { fsPath } })) })),
    fireDeleteFiles: (...p) => fired.deleteFiles.forEach((fn) => fn({ files: p.map((fsPath) => ({ fsPath, uri: { fsPath } })) })),
    vscode: {
      EventEmitter: VscodeEmitter,
      workspace: {
        workspaceFolders: [folder],
        getConfiguration: () => ({ get: () => undefined }),
        createFileSystemWatcher: () => watcher,
        onDidCreateFiles: on(fired.createFiles),
        onDidDeleteFiles: on(fired.deleteFiles),
        onDidRenameFiles: on(fired.renameFiles),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeConfiguration: () => ({ dispose() {} })
      }
    }
  };
}

test('changes the outline cannot show do not invalidate it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burstcode-index-'));
  try {
    for (const sub of ['.burstcode/checkpoints/1795591012429', 'src', '.github/workflows', 'node_modules/pkg', 'docs']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    const { vscode, ...fire } = vscodeMock(dir);
    const logs = [];
    const logger = { debug: (m) => logs.push(m), info() {}, warn(m) { logs.push(m); }, error() {} };
    const { WorkspaceIndex } = await loadTs('src/context/WorkspaceIndex.ts', { vscode });
    const index = new WorkspaceIndex(logger);

    const outline = await index.getOutline();
    assert.equal(await index.getOutline(), outline, 'served from the cache');
    assert.equal(outline.text.includes('.burstcode'), false, 'hidden directories are not part of the outline');
    assert.equal(outline.text.includes('node_modules'), false);
    logs.length = 0;

    // BurstCode's own writes: one checkpoint per prompt, plus the background reports.
    const own = [
      path.join(dir, '.burstcode', 'checkpoints', '1795591084448'),
      path.join(dir, '.burstcode', 'checkpoints', '1795591084448', 'manifest.json'),
      path.join(dir, '.burstcode', 'README.md')
    ];
    fire.fireCreate(...own);
    fire.fireCreateFiles(...own);
    fire.fireDelete(path.join(dir, '.burstcode', 'checkpoints', '1795591012429', 'manifest.json'));
    fire.fireDeleteFiles(path.join(dir, '.burstcode', 'checkpoints', '1795591012429'));
    fire.fireCreate(path.join(dir, 'node_modules', 'pkg', 'index.js'));
    assert.equal(await index.getOutline(), outline, 'still the cached outline');
    assert.deepEqual(logs, [], 'nothing was invalidated');

    // A real change to what the outline lists is still picked up.
    const real = [
      path.join(dir, 'src', 'new.ts'),
      path.join(dir, 'docs'),
      path.join(dir, '.github', 'workflows', 'ci.yml')
    ];
    for (const changed of real) {
      fire.fireCreate(changed);
      const rebuilt = await index.getOutline();
      assert.notEqual(rebuilt, outline, `${path.relative(dir, changed)} rebuilds the outline`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS: ${name}`); } catch (err) { failed++; console.error(`FAIL: ${name}\n${(err && err.stack) || err}`); }
  }
  if (failed) process.exitCode = 1;
})();
