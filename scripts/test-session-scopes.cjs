const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const js = ts.transpileModule(fs.readFileSync('src/chat/SessionStore.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {}, require: () => ({}) };
vm.runInNewContext(js, sandbox);
const Store = sandbox.exports.SessionStore;
function memory() {
  const map = new Map();
  return { get: k => map.get(k), update: async (k, v) => { if (v === undefined) map.delete(k); else map.set(k, JSON.parse(JSON.stringify(v))); } };
}
function session(id) { return { id, title: id, createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'hello' }] }; }
(async () => {
  const global = memory(), wa = memory(), wb = memory();
  const a = new Store(wa, global, 'A', 'Project A'), b = new Store(wb, global, 'B', 'Project B');
  await a.save(session('one'));
  assert.equal(a.get('one').scope, 'workspace');
  assert.equal(b.get('one'), undefined);
  await a.move('one', 'global');
  assert.equal(b.get('one').messages[0].content, 'hello');
  assert.equal(b.get('one').originWorkspace, 'Project A');
  await b.move('one', 'workspace');
  assert.equal(a.get('one'), undefined);
  assert.equal(b.get('one').workspaceId, 'B');
  const legacy = session('old');
  legacy.checkpoints = [{ messageIndex: 0, ref: 'file:1', sha: '', createdAt: 1, label: 'old' }];
  await wa.update('burstcode.sessions.index', [legacy]);
  await wa.update('burstcode.session.old', legacy);
  assert.equal(a.get('old').checkpoints[0].workspaceId, 'A');
  await a.move('old', 'global');
  assert.equal(b.get('old').checkpoints[0].workspaceId, 'A');
  assert.equal(wa.get('burstcode.session.old'), undefined);
  await b.save(session('private'));
  await a.clear();
  assert.ok(b.get('private'));
  assert.ok(b.get('one'));
  assert.equal(b.get('old'), undefined);
  console.log('PASS: default workspace isolation, global visibility, bidirectional moves, origin retention, legacy migration, checkpoint ownership, isolated deletion');
})().catch(err => { console.error(err); process.exitCode = 1; });
