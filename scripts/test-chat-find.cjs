// Regression checks for the generated Webview search protocol and text-only pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/chat/SessionStore.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {}, require: () => ({}) };
vm.runInNewContext(js, sandbox);
const build = sandbox.exports.buildTranscriptRange;
const messages = [];
for (let i = 0; i < 300; i++) messages.push({ role: 'user', content: 'entry ' + i + ' needle needle' });
messages.push({ role: 'assistant', content: 'answer', tool_calls: [{ id: 't', function: { name: 'collect_context', arguments: '{invalid-json' } }] });
messages.push({ role: 'tool', tool_call_id: 't', content: 'x'.repeat(5000) + ' needle' });
const all = build(messages, undefined, 0, Infinity, true);
assert.equal(all.total, 302);
assert.equal(all.entries[301].text.endsWith('needle'), true);
assert.equal(all.entries[301].args, undefined);
const page = build(messages, undefined, 297, 302, true);
assert.equal(page.entries.length, 5);
assert.equal(page.entries[4].text.length, 5007);
const script = fs.readFileSync('scripts/.burstcode-webview-script.js', 'utf8');
function fn(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}
const sent = [];
const context = { currentFindMatches: [{ index: 2, occurrence: 0 }, { index: 2, occurrence: 1 }, { index: 299, occurrence: 0 }], currentFindIndex: 0, updateFindCounter() {}, revealFindMatch() {} };
vm.createContext(context); vm.runInContext(fn('moveFind'), context);
context.moveFind(-1); assert.equal(context.currentFindIndex, 2);
context.moveFind(1); assert.equal(context.currentFindIndex, 0);
context.moveFind(1); assert.equal(context.currentFindIndex, 1);
assert.ok(script.includes("payload.requestId !== findRequestId"));
assert.ok(script.includes("payload.requestId !== findPageRequest"));
assert.ok(script.includes("if (currentFindBar) return;"));
console.log('PASS: full-session text index, repeated occurrences, large tool output, bounded page, wrap-around navigation and stale-response guards');
