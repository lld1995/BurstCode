// Run after extract-webview-script.js; exercise the actual cooked Webview helpers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/chat/ChatViewProvider.ts', 'utf8');
const script = fs.readFileSync('scripts/.burstcode-webview-script.js', 'utf8');
const start = script.indexOf('const pendingTextCopies =');
const end = script.indexOf('\nfunction bindCodeCopy(', start);
assert.ok(start >= 0 && end > start);
const sent = [], timers = new Map(), listeners = {};
let timerId = 0;
const context = {
  vscode: { postMessage: msg => sent.push(msg) },
  document: { activeElement: { tagName: 'BODY' }, addEventListener: (name, cb) => { listeners[name] = cb; } },
  window: { getSelection: () => ({ isCollapsed: false, toString: () => '新选区\nsecond line' }) },
  setTimeout: cb => { timers.set(++timerId, cb); return timerId; },
  clearTimeout: id => timers.delete(id)
};
vm.createContext(context);
vm.runInContext(script.slice(start, end), context);
async function main() {
  let settled = false;
  const first = context.copyText('new text').then(ok => { settled = true; return ok; });
  await Promise.resolve();
  assert.equal(settled, false, 'must wait for host acknowledgement');
  assert.equal(sent[0].type, 'copy-text');
  assert.equal(sent[0].payload.text, 'new text');
  context.handleCopyTextResult({ requestId: sent[0].payload.requestId, ok: true });
  assert.equal(await first, true);
  const failed = context.copyText('rejected');
  context.handleCopyTextResult({ requestId: sent[1].payload.requestId, ok: false });
  assert.equal(await failed, false, 'failure must not become Copied');
  const timeout = context.copyText('timeout');
  [...timers.values()][0]();
  assert.equal(await timeout, false);
  context.handleCopyTextResult({ requestId: 'unknown', ok: true });
  let prevented = 0;
  const event = { preventDefault: () => prevented++, stopPropagation() {} };
  listeners.copy(event);
  assert.equal(prevented, 1);
  assert.equal(sent.at(-1).payload.text, '新选区\nsecond line');
  for (const active of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
    context.document.activeElement = active;
    listeners.copy(event);
    assert.equal(prevented, 1, 'editable selection must retain native copy');
  }
  context.document.activeElement = { tagName: 'BODY' };
  context.window.getSelection = () => ({ isCollapsed: true });
  listeners.copy(event);
  assert.equal(prevented, 1, 'empty selection must not replace clipboard');

  // Exercise the real extension-side handler without constructing the provider.
  const tree = ts.createSourceFile('provider.ts', source, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ChatViewProvider');
  const method = cls.members.find(n => n.name && n.name.getText(tree) === 'handleMessage');
  let written;
  const results = [], warnings = [];
  const host = { vscode: { env: { clipboard: { writeText: async text => { written = text; } } }, window: { showWarningMessage: text => warnings.push(text) } } };
  vm.createContext(host);
  const js = ts.transpileModule('async function handleMessage(msg) ' + method.body.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(js, host);
  const provider = { post: msg => results.push(msg), logger: { warn() {} } };
  await host.handleMessage.call(provider, sent[0]);
  assert.equal(written, 'new text');
  assert.equal(results.at(-1).payload.ok, true);
  host.vscode.env.clipboard.writeText = async () => { throw Error('clipboard unavailable'); };
  await host.handleMessage.call(provider, sent[1]);
  assert.equal(results.at(-1).payload.ok, false);
  assert.equal(warnings.length, 1);
  const count = results.length;
  await host.handleMessage.call(provider, { type: 'copy-text', payload: { requestId: 'bad', text: 123 } });
  assert.equal(results.length, count);
  assert.ok(!script.includes('navigator.clipboard.writeText'), 'all text copy paths must use host');
  assert.ok(!script.includes('p.then(done, done)'), 'no false success callbacks');
  console.log('PASS: host clipboard success/failure, acknowledgement, timeout, selection copy, editable/native copy, malformed requests and text-copy routing');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
