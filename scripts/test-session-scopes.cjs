const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const js = ts.transpileModule(fs.readFileSync('src/chat/SessionStore.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {}, require: name => (name === 'vscode' ? {} : require(name)), Buffer, process };
vm.runInNewContext(js, sandbox);
const Store = sandbox.exports.SessionStore;
function memory() {
  const map = new Map();
  return { get: k => map.get(k), update: async (k, v) => { if (v === undefined) map.delete(k); else map.set(k, JSON.parse(JSON.stringify(v))); } };
}
function session(id) { return { id, title: id, createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'hello' }] }; }
(async () => {
  // Two windows of one machine: separate mementos, one session directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burstcode-scopes-'));
  const global = memory(), wa = memory(), wb = memory();
  const a = new Store(wa, global, dir, 'A', 'Project A'), b = new Store(wb, global, dir, 'B', 'Project B');
  await a.save(session('s_one'));
  assert.equal(a.get('s_one').scope, 'workspace');
  assert.equal(b.get('s_one'), undefined);
  await a.move('s_one', 'global');
  assert.equal(b.get('s_one').messages[0].content, 'hello');
  assert.equal(b.get('s_one').originWorkspace, 'Project A');
  await b.move('s_one', 'workspace');
  assert.equal(a.get('s_one'), undefined);
  assert.equal(b.get('s_one').workspaceId, 'B');
  // A legacy body that only shows up after the activation-time migration ran.
  const legacy = session('s_old');
  legacy.checkpoints = [{ messageIndex: 0, ref: 'file:1', sha: '', createdAt: 1, label: 'old' }];
  await wa.update('burstcode.sessions.index', [legacy]);
  await wa.update('burstcode.session.s_old', legacy);
  assert.equal(a.get('s_old').checkpoints[0].workspaceId, 'A');
  await a.move('s_old', 'global');
  assert.equal(b.get('s_old').checkpoints[0].workspaceId, 'A');
  assert.equal(wa.get('burstcode.session.s_old'), undefined);
  await b.save(session('s_private'));
  await a.clear();
  assert.ok(b.get('s_private'));
  assert.ok(b.get('s_one'));
  assert.equal(b.get('s_old'), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: default workspace isolation, global visibility, bidirectional moves, origin retention, legacy migration, checkpoint ownership, isolated deletion');
})().catch(err => { console.error(err); process.exitCode = 1; });
