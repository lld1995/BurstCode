// Session storage regression checks: bodies live in one file per session on the
// extension host's disk, the memento keeps only a KB-sized index, legacy memento
// bodies migrate once, and an interrupted run survives a restart.
// Run: node scripts/test-session-store.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath, pathToFileURL } = require('node:url');
const ts = require('typescript');

const source = fs.readFileSync('src/chat/SessionStore.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
// The store resolves the path of a recorded workspace through vscode.Uri.
function load(vscodeMock = {}) {
  const vscode = { Uri: { parse: uri => ({ fsPath: fileURLToPath(uri) }) }, ...vscodeMock };
  const sandbox = { exports: {}, require: name => (name === 'vscode' ? vscode : require(name)), Buffer, process };
  vm.runInNewContext(js, sandbox);
  return sandbox.exports;
}
const { SessionStore, finalizeInterruptedTurn } = load();

// Objects built inside the sandbox have another realm's prototypes, so compare
// them structurally.
const plain = value => JSON.parse(JSON.stringify(value));

// VS Code coalesces same-macro-task memento updates into ONE storage write, and
// each write re-sends the whole extension state. `tick` tells updates apart so
// the tests can assert that a batch of updates really shares one task.
const clock = { tick: 0, timer: undefined };
const advance = () => { clock.tick++; clock.timer = setTimeout(advance, 0); };

function memento(seed) {
  const map = new Map(seed ? JSON.parse(JSON.stringify([...seed])) : []);
  const api = {
    map,
    updates: [],
    get: key => map.get(key),
    async update(key, value) {
      api.updates.push({ key, tick: clock.tick });
      if (value === undefined) map.delete(key);
      else map.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
  return api;
}

const INDEX = 'burstcode.sessions.shared.index';
const bodyOf = id => 'burstcode.session.' + id;
const fileOf = (dir, id) => path.join(dir, id + '.json');
function body(id, extra = {}) {
  return { id, title: id, createdAt: 2, updatedAt: 2, messages: [{ role: 'user', content: id }], ...extra };
}
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
async function withDir(fn) {
  const dir = tempDir('burstcode-store-');
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the body goes to disk, the index to the memento, and get() returns the saved object', () => withDir(async (dir) => {
  const global = memento();
  const store = new SessionStore(memento(), global, dir, 'ws-A', 'Project A');
  const session = { ...body('s_one'), messages: [{ role: 'user', content: 'hello' }] };
  await store.save(session);
  const stored = JSON.parse(fs.readFileSync(fileOf(dir, 's_one'), 'utf8'));
  assert.equal(stored.messages[0].content, 'hello');
  assert.equal(stored.owner, 'local');
  assert.equal(stored.scope, 'workspace');
  assert.equal(stored.workspaceId, 'ws-A');
  assert.deepEqual([...global.map.keys()], [INDEX], 'only the index is stored in the memento');
  assert.equal(global.get(INDEX)[0].id, 's_one');
  assert.equal(global.get(INDEX)[0].owner, 'local');
  assert.equal(store.get('s_one'), session, 'the very object that was saved');
  assert.equal(store.get('../escape'), undefined, 'an id is never used as a path unchecked');
  assert.equal(store.get('s_missing'), undefined);
  assert.ok(store.sizeOf('s_one') > 0);
}));

test('a restarted extension host reads the session back from its file', () => withDir(async (dir) => {
  const global = memento();
  await new SessionStore(memento(), global, dir, 'file:///e%3A/project/x', 'x').save({ ...body('s_keep'), title: 'kept' });
  // Fresh memento objects stand for a host that reloaded its state from disk.
  const restarted = new SessionStore(memento(), memento(global.map), dir, 'file:///e%3A/project/x', 'x');
  const loaded = restarted.get('s_keep');
  assert.equal(loaded.title, 'kept');
  assert.equal(loaded.messages[0].content, 's_keep');
  // The same object on every access, so the current tab never forks from storage.
  assert.equal(restarted.get('s_keep'), loaded);
  assert.equal(await restarted.load('s_keep'), loaded);
}));

test('each machine migrates only the legacy sessions whose workspace lives on it, in one storage write', async () => {
  const localDir = tempDir('burstcode-store-local-');
  const remoteDir = tempDir('burstcode-store-remote-');
  const remoteWorkspacePath = path.join(tempDir('burstcode-store-ws-'), 'proj');
  try {
    const global = memento();
    // A remote workspace reaches the extension host as a plain file URI too,
    // so its scheme says nothing about which machine holds it.
    const remoteWorkspace = pathToFileURL(remoteWorkspacePath).href;
    const localWorkspace = pathToFileURL(process.cwd()).href;
    const metas = [
      { id: 's_local', title: 'local', createdAt: 3, updatedAt: 3, scope: 'workspace', workspaceId: localWorkspace, originWorkspace: 'sm_ai' },
      { id: 's_global', title: 'global', createdAt: 4, updatedAt: 4, scope: 'global', workspaceId: remoteWorkspace, originWorkspace: 'proj' },
      { id: 's_remote', title: 'remote', createdAt: 5, updatedAt: 5, scope: 'workspace', workspaceId: remoteWorkspace, originWorkspace: 'proj' },
      { id: 's_free', title: 'free', createdAt: 6, updatedAt: 6, scope: 'global' }
    ];
    await global.update(INDEX, metas);
    for (const meta of metas) await global.update(bodyOf(meta.id), body(meta.id));
    global.updates.length = 0;

    const local = new SessionStore(memento(), global, localDir, localWorkspace, 'sm_ai');
    await local.ready;
    assert.ok(fs.existsSync(fileOf(localDir, 's_local')));
    assert.ok(fs.existsSync(fileOf(localDir, 's_free')), 'a session with no recorded origin goes to the first machine that starts');
    assert.equal(fs.existsSync(fileOf(localDir, 's_global')), false, "another machine's session is left for that machine");
    assert.equal(fs.existsSync(fileOf(localDir, 's_remote')), false);
    assert.equal(global.get(bodyOf('s_local')), undefined);
    assert.equal(global.get(bodyOf('s_free')), undefined);
    assert.ok(global.get(bodyOf('s_global')), 'the other machine still finds its legacy body');
    assert.deepEqual(plain(local.list().map(s => s.id).sort()), ['s_free', 's_local']);
    assert.equal(local.get('s_local').messages[0].content, 's_local');
    const removals = global.updates.filter(u => u.key.startsWith('burstcode.session.'));
    assert.equal(removals.length, 2);
    const publish = global.updates.filter(u => u.key === INDEX).at(-1);
    assert.equal(new Set([...removals, publish].map(u => u.tick)).size, 1,
      'dropping the legacy keys and publishing the index must be one storage write');

    // The remote machine connects later and finds the workspace on its own disk.
    fs.mkdirSync(remoteWorkspacePath, { recursive: true });
    const remoteOwner = { id: 'remote:11111111-1111-1111-1111-111111111111', remote: true, workspaces: [] };
    const remote = new SessionStore(memento(), global, remoteDir, remoteWorkspace, 'proj', remoteOwner);
    await remote.ready;
    assert.ok(fs.existsSync(fileOf(remoteDir, 's_global')));
    assert.ok(fs.existsSync(fileOf(remoteDir, 's_remote')));
    assert.equal(global.get(bodyOf('s_global')), undefined);
    assert.equal(global.get(bodyOf('s_remote')), undefined);
    assert.deepEqual(plain(remote.list().map(s => s.id).sort()), ['s_global', 's_remote'],
      'the sessions the local machine claimed are not listed remotely');
    assert.deepEqual(plain(global.get(INDEX).map(s => s.id).sort()), ['s_free', 's_global', 's_local', 's_remote']);
    assert.equal(global.get(INDEX).find(s => s.id === 's_remote').owner, remoteOwner.id);
    // A later local window no longer sees the remote ones, not even the global one.
    const localAgain = new SessionStore(memento(), global, localDir, localWorkspace, 'sm_ai');
    assert.deepEqual(plain(localAgain.list().map(s => s.id).sort()), ['s_free', 's_local']);
  } finally {
    for (const dir of [localDir, remoteDir, path.dirname(remoteWorkspacePath)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('migration is idempotent when interrupted between writing the file and dropping the key', () => withDir(async (dir) => {
  const global = memento();
  const halfWorkspace = pathToFileURL(dir).href;
  await global.update(INDEX, [{ id: 's_half', title: 'half', createdAt: 7, updatedAt: 7, scope: 'workspace', workspaceId: halfWorkspace, originWorkspace: 'half' }]);
  await global.update(bodyOf('s_half'), body('s_half'));
  fs.writeFileSync(fileOf(dir, 's_half'), JSON.stringify(body('s_half', { title: 'written before the crash' })));
  const store = new SessionStore(memento(), global, dir, halfWorkspace, 'half');
  await store.ready;
  assert.equal(global.get(bodyOf('s_half')), undefined, 'the leftover key is dropped');
  assert.equal(store.get('s_half').title, 'written before the crash', 'the file already on disk wins');
  assert.equal(global.get(INDEX)[0].owner, 'local');
  // Nothing left to do on the next activation.
  global.updates.length = 0;
  await new SessionStore(memento(), global, dir, halfWorkspace, 'half').ready;
  assert.equal(global.updates.length, 0);
}));

test('a legacy body that turns up after activation is dropped by the next save', () => withDir(async (dir) => {
  const global = memento(), ws = memento();
  const store = new SessionStore(ws, global, dir, 'ws', 'ws');
  const legacy = body('s_late', { checkpoints: [{ messageIndex: 0, ref: 'file:1', sha: '', createdAt: 1, label: 'late' }] });
  await ws.update('burstcode.sessions.index', [legacy]);
  await ws.update(bodyOf('s_late'), legacy);
  assert.equal(store.get('s_late').checkpoints[0].workspaceId, 'ws', 'still readable through the legacy fallback');
  await store.move('s_late', 'global');
  assert.ok(fs.existsSync(fileOf(dir, 's_late')));
  assert.equal(ws.get(bodyOf('s_late')), undefined);
  assert.equal((ws.get('burstcode.sessions.index') ?? []).length, 0, 'the workspace index no longer lists it');
  assert.equal(global.get(bodyOf('s_late')), undefined);
  assert.equal(global.get(INDEX)[0].owner, 'local');
}));

test('the index is lined up with the session files on activation', () => withDir(async (dir) => {
  const global = memento();
  await global.update(INDEX, [
    { id: 's_ghost', title: 'ghost', createdAt: 1, updatedAt: 3, scope: 'global', owner: 'local' },
    { id: 's_elsewhere', title: 'elsewhere', createdAt: 1, updatedAt: 2, scope: 'global', owner: 'remote:other' },
    { id: 's_taken', title: 'taken', createdAt: 1, updatedAt: 1, scope: 'global', owner: 'remote:previous-id' }
  ]);
  // Another window saved this session, but its index write was lost.
  fs.writeFileSync(fileOf(dir, 's_orphan'), JSON.stringify(body('s_orphan', { title: 'orphan', owner: 'local' })));
  // And this machine's storage id was recreated since the entry was written.
  fs.writeFileSync(fileOf(dir, 's_taken'), JSON.stringify(body('s_taken', { title: 'taken', owner: 'remote:previous-id' })));
  const store = new SessionStore(memento(), global, dir, 'ws', 'ws');
  await store.ready;
  assert.deepEqual(plain(store.list().map(s => s.id).sort()), ['s_orphan', 's_taken']);
  const index = global.get(INDEX);
  assert.equal(index.find(s => s.id === 's_orphan').title, 'orphan', 'the unindexed file is adopted');
  assert.equal(index.some(s => s.id === 's_ghost'), false, 'an entry without its file is dropped');
  assert.ok(index.some(s => s.id === 's_elsewhere'), "another machine's entry is left alone");
  assert.equal(index.find(s => s.id === 's_taken').owner, 'local', 'a file on this machine belongs to this machine');
}));

test('delete and clear remove the files and their index entries', () => withDir(async (dir) => {
  const global = memento();
  const store = new SessionStore(memento(), global, dir, 'ws', 'ws');
  for (const id of ['s_a', 's_b', 's_c']) await store.save(body(id));
  await store.delete('s_b');
  assert.equal(fs.existsSync(fileOf(dir, 's_b')), false);
  assert.equal(store.get('s_b'), undefined);
  assert.equal(global.get(INDEX).length, 2);
  await store.clear();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(global.get(INDEX).length, 0);
}));

test('saves issued while a write is in flight are coalesced into one follow-up write', () => withDir(async (dir) => {
  const realWrite = fs.promises.writeFile;
  let writes = 0;
  fs.promises.writeFile = async (...args) => { writes++; await new Promise(resolve => setTimeout(resolve, 25)); return realWrite(...args); };
  try {
    const store = new SessionStore(memento(), memento(), dir, 'ws', 'ws');
    const session = body('s_stream');
    const saves = [];
    for (let i = 0; i < 25; i++) {
      session.messages.push({ role: 'assistant', content: `chunk ${i}` });
      saves.push(store.save(session));
    }
    await Promise.all(saves);
    assert.ok(writes <= 3, `expected a couple of writes, got ${writes}`);
    assert.equal(JSON.parse(fs.readFileSync(fileOf(dir, 's_stream'), 'utf8')).messages.length, 26, 'the newest state is what ends up on disk');
    assert.deepEqual(fs.readdirSync(dir), ['s_stream.json'], 'no write-ahead file is left behind');
  } finally { fs.promises.writeFile = realWrite; }
}));

test('finalizeInterruptedTurn keeps a partially streamed answer and closes open tool calls', () => {
  const call = id => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } });
  const session = {
    ...body('s_run', { status: 'running' }),
    messages: [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [call('call_1'), call('call_2')] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' }
    ],
    pending: { assistantText: 'Here is the first part of the answer', reasoningText: 'thinking about it', savedAt: 1 }
  };
  assert.equal(finalizeInterruptedTurn(session), true);
  assert.equal(session.pending, undefined);
  const roles = session.messages.map(m => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(session.messages[2].content, 'file contents', 'the answered call is left as it was');
  assert.equal(session.messages[3].tool_call_id, 'call_2', 'the unanswered tool call gets a result');
  assert.match(session.messages[3].content, /\[interrupted\]/);
  assert.match(session.messages[4].content, /^Here is the first part of the answer/);
  assert.match(session.messages[4].content, /Answer interrupted/);
  assert.equal(session.messages[4].reasoning_content, 'thinking about it');
  // Already finalized: nothing changes.
  assert.equal(finalizeInterruptedTurn(session), false);
  assert.deepEqual(session.messages.map(m => m.role), roles);
  // Nothing had streamed yet: only the open tool call is closed.
  const early = {
    ...body('s_early'),
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [call('call_9')] }],
    pending: { assistantText: '', reasoningText: '', savedAt: 1 }
  };
  assert.equal(finalizeInterruptedTurn(early), true);
  assert.deepEqual(early.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  // A finished turn is untouched.
  const done = { ...body('s_done'), messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  assert.equal(finalizeInterruptedTurn(done), false);
  assert.equal(done.messages.length, 2);
});

test('a session persisted mid-run comes back as a stopped chat that keeps what was generated', () => withDir(async (dir) => {
  const global = memento();
  await new SessionStore(memento(), global, dir, 'ws', 'ws').save({
    ...body('s_crash', { status: 'running', pending: { assistantText: 'The answer so far', reasoningText: '', savedAt: 1 } }),
    messages: [{ role: 'user', content: 'question' }]
  });
  // What the extension host does on its next start for a session left as running.
  const next = new SessionStore(memento(), memento(global.map), dir, 'ws', 'ws');
  const recovered = await next.load('s_crash');
  assert.equal(recovered.status, 'running');
  finalizeInterruptedTurn(recovered);
  recovered.status = 'stopped';
  await next.save(recovered);
  const persisted = JSON.parse(fs.readFileSync(fileOf(dir, 's_crash'), 'utf8'));
  assert.equal(persisted.status, 'stopped');
  assert.equal(persisted.pending, undefined);
  assert.match(persisted.messages[1].content, /The answer so far/);
}));

test('a chat can be renamed without changing its place in the history', () => withDir(async (dir) => {
  const global = memento();
  const store = new SessionStore(memento(), global, dir, 'ws', 'ws');
  await store.save({ ...body('s_old', { title: 'old', createdAt: 1, updatedAt: 1 }) });
  await store.save({ ...body('s_new', { title: 'new', createdAt: 2, updatedAt: 2 }) });
  assert.equal(await store.rename('s_old', '  Renamed chat  '), true, 'the chat is renamed');
  assert.deepEqual(plain(store.list().map((s) => s.id)), ['s_new', 's_old'], 'still ordered by update time');
  assert.equal(global.get(INDEX).find((s) => s.id === 's_old').title, 'Renamed chat', 'leading and trailing blanks are dropped');
  assert.equal(global.get(INDEX).find((s) => s.id === 's_old').updatedAt, 1);
  assert.equal(JSON.parse(fs.readFileSync(fileOf(dir, 's_old'), 'utf8')).title, 'Renamed chat', 'the session itself is rewritten too');
  assert.equal((await store.load('s_old')).title, 'Renamed chat');
  // A chat that was open keeps the same object, so a rename is seen at once.
  const open = await store.load('s_new');
  await store.rename('s_new', 'Also renamed');
  assert.equal(open.title, 'Also renamed');
  assert.equal(await store.rename('s_missing', 'x'), false);
}));

test('snapshots of a running session do not rewrite the index unless its entry changed', () => withDir(async (dir) => {
  const global = memento();
  const store = new SessionStore(memento(), global, dir, 'ws', 'ws');
  const session = { ...body('s_snap'), status: 'running' };
  await store.save(session);
  const published = { ...global.get(INDEX)[0] };
  assert.equal(published.status, 'running');
  global.updates.length = 0;
  // Periodic snapshots: the body advances, the index entry does not.
  for (const part of [1, 2, 3]) {
    session.messages.push({ role: 'assistant', content: `part ${part}` });
    session.updatedAt = published.updatedAt + part;
    await store.save(session, { index: false });
  }
  assert.equal(global.updates.length, 0, 'a snapshot that changed nothing but the update time is not a storage write');
  assert.equal(global.get(INDEX)[0].updatedAt, published.updatedAt);
  assert.equal(JSON.parse(fs.readFileSync(fileOf(dir, 's_snap'), 'utf8')).messages.at(-1).content, 'part 3', 'the file still gets every snapshot');
  // The end of the run changes the entry, so even a snapshot publishes it.
  session.status = 'completed';
  await store.save(session, { index: false });
  assert.equal(global.get(INDEX)[0].status, 'completed');
  // An explicit save always refreshes the entry.
  global.updates.length = 0;
  session.updatedAt += 1000;
  await store.save(session);
  assert.equal(global.updates.length, 1);
  assert.equal(global.get(INDEX)[0].updatedAt, session.updatedAt);
}));

test('an explicit save arriving while a snapshot is being written still publishes the index', () => withDir(async (dir) => {
  const realWrite = fs.promises.writeFile;
  fs.promises.writeFile = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 25)); return realWrite(...args); };
  try {
    const global = memento();
    const store = new SessionStore(memento(), global, dir, 'ws', 'ws');
    const session = body('s_mix');
    await store.save(session);
    const snapshot = store.save(session, { index: false });
    session.updatedAt += 5;
    const explicit = store.save(session);
    await Promise.all([snapshot, explicit]);
    assert.equal(global.get(INDEX)[0].updatedAt, session.updatedAt);
  } finally { fs.promises.writeFile = realWrite; }
}));

test('a memento flush that never completes does not hold back activation or saving to disk', () => withDir(async (dir) => {
  // VS Code applies an update to the host's value at once and resolves the
  // promise only once the renderer has flushed it. A renderer that is
  // struggling never answers.
  const stuck = () => {
    const map = new Map();
    return {
      map,
      get: key => map.get(key),
      update(key, value) {
        if (value === undefined) map.delete(key);
        else map.set(key, JSON.parse(JSON.stringify(value)));
        return new Promise(() => undefined);
      }
    };
  };
  const within = (promise, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} waited for the flush`)), 2000))
  ]);
  const global = stuck();
  global.update(INDEX, [{ id: 's_old', title: 'old', createdAt: 1, updatedAt: 1, scope: 'global' }]);
  global.update(bodyOf('s_old'), body('s_old'));
  const store = new SessionStore(stuck(), global, dir, 'ws', 'ws');
  await within(store.ready, 'activation');
  assert.ok(fs.existsSync(fileOf(dir, 's_old')), 'the legacy body reached disk');
  assert.equal(global.get(bodyOf('s_old')), undefined, 'its release was applied although the flush is pending');
  await within(store.save(body('s_new')), 'save');
  assert.equal(JSON.parse(fs.readFileSync(fileOf(dir, 's_new'), 'utf8')).id, 's_new');
  await within(store.delete('s_new'), 'delete');
  assert.equal(fs.existsSync(fileOf(dir, 's_new')), false);
}));

test('detectSessionOwner separates the local machine from each remote one', () => withDir(async (dir) => {
  const folder = { uri: { toString: () => 'file:///c:/work/proj' } };
  const detect = (extra, storageDir = dir) => plain(load(extra).detectSessionOwner(storageDir));
  assert.deepEqual(detect({ env: {}, workspace: { workspaceFolders: [folder] } }),
    { id: 'local', remote: false, workspaces: ['file:///c:/work/proj'] });
  // The extension host API cannot name the remote, so the machine identifies itself...
  const remote = { env: { remoteName: 'ssh-remote' }, workspace: {} };
  const first = detect(remote);
  assert.match(first.id, /^remote:[0-9a-f-]{36}$/);
  assert.equal(first.remote, true);
  assert.deepEqual(first.workspaces, []);
  // ...with an id that is stable across windows and unlike another machine's.
  assert.equal(detect(remote).id, first.id);
  assert.notEqual(detect(remote, path.join(dir, 'other-machine')).id, first.id);
  assert.ok(fs.existsSync(path.join(dir, 'session-owner-id')));
}));

(async () => {
  advance();
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS: ${name}`); } catch (err) { failed++; console.error(`FAIL: ${name}\n${(err && err.stack) || err}`); }
  }
  clearTimeout(clock.timer);
  if (failed) process.exitCode = 1;
})()
