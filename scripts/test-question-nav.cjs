// Regression checks against the cooked Webview code, not the TS template source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('scripts/.burstcode-webview-script.js', 'utf8');
function fn(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const end = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}
function element() {
  const classes = new Set();
  return {
    children: [], dataset: {}, style: {}, listeners: {}, attrs: {},
    classList: { toggle(c, enabled) { enabled ? classes.add(c) : classes.delete(c); }, contains(c) { return classes.has(c); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.listeners[k] = f; },
    appendChild(el) { this.children.push(el); },
    replaceChildren() { this.children = []; }
  };
}
const sent = [];
const context = {
  document: { createElement: element }, questionNav: element(), questionTooltip: {},
  questionEntries: [{ index: 0, messageIndex: 1, text: 'first' }, { index: 40, messageIndex: 90, text: 'second' }, { index: 250, messageIndex: 500, text: 'third' }],
  currentFindQuery: 'needle', currentFindMatches: [{ index: 7 }, { index: 249 }, { index: 250 }], questionTarget: 90,
  findPageRequest: 0, findScrollFrame: 0, questionRequest: 0, currentFindBar: {},
  log: { children: [] }, loadedTranscriptSessionId: 'session-A', sessionsCache: {},
  vscode: { postMessage(msg) { sent.push(msg); } }
};
vm.createContext(context);
['questionPreview', 'questionForIndex', 'renderQuestionNav', 'revealQuestion'].forEach((name) => vm.runInContext(fn(name), context));
assert.equal(context.questionPreview('a\n b\t c'), 'a b c');
assert.equal(context.questionPreview('😀'.repeat(161)), '😀'.repeat(160) + '…');
assert.equal(context.questionPreview(''), '[图片提问]');
assert.equal(context.questionForIndex(-1), -1);
assert.equal(context.questionForIndex(39), 0);
assert.equal(context.questionForIndex(40), 1);
assert.equal(context.questionForIndex(249), 1);
context.renderQuestionNav();
assert.equal(context.questionNav.children.length, 3);
assert.ok(context.questionNav.children.every((button) => button.classList.contains('search-hit')));
assert.ok(context.questionNav.children[1].classList.contains('active'));
context.currentFindQuery = ''; context.renderQuestionNav();
assert.ok(context.questionNav.children.every((button) => !button.classList.contains('search-hit')));
context.revealQuestion(context.questionEntries[2]);
assert.equal(sent[0].payload.index, 250);
assert.equal(sent[0].payload.purpose, 'question');
assert.equal(sent[0].payload.id, 'session-A');
assert.equal(context.findPageRequest, 1);
assert.ok(script.includes('payload.requestId === questionRequest'));
// Scrolling to the bottom must prefer the last turn over the viewport top.
context.currentFindBar = null;
context.findPage = null;
let atBottom = false;
context.isLogAtBottom = () => atBottom;
context.log.getBoundingClientRect = () => ({ top: 0, bottom: 600 });
context.log.querySelectorAll = () => [
  { dataset: { messageIndex: '1' }, getBoundingClientRect: () => ({ top: -20 }) },
  { dataset: { messageIndex: '90' }, getBoundingClientRect: () => ({ top: 240 }) },
  { dataset: { messageIndex: '500' }, getBoundingClientRect: () => ({ top: 460 }) }
];
vm.runInContext(fn('updateQuestionNavActive'), context);
context.updateQuestionNavActive();
assert.equal(context.questionTarget, 1);
atBottom = true;
context.updateQuestionNavActive();
assert.equal(context.questionTarget, 500);
assert.ok(context.questionNav.children[2].classList.contains('active'));
// A new prompt is appended while the viewport still contains older turns.
context.questionEntries.push({ index: 251, messageIndex: 501, text: 'new prompt' });
context.renderQuestionNav();
assert.equal(context.questionTarget, 501);
assert.ok(context.questionNav.children[3].classList.contains('active'));
atBottom = false;
context.updateQuestionNavActive();
assert.equal(context.questionTarget, 1);
// A historical question page's bottom is not the live transcript bottom.
context.findPage = {};
atBottom = true;
context.updateQuestionNavActive();
assert.equal(context.questionTarget, 1);
assert.ok(fn('scheduleScrollToBottom').includes('updateQuestionNavActive();'));
console.log('PASS: question preview, search markers, navigation, bottom activation, new prompts and historical-page guard');
