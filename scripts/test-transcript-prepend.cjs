const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('scripts/.burstcode-webview-script.js', 'utf8');
const start = script.indexOf('function renderTranscript(');
const end = script.indexOf('\nfunction replayLiveState(', start);
function container() {
  return {
    children: [], scrollTop: 20,
    get firstChild() { return this.children[0]; },
    get lastElementChild() { return this.children.at(-1); },
    get scrollHeight() { return this.children.length * 100; },
    querySelector() { return null; },
    appendChild(node) {
      if (node.fragment) { while (node.firstChild) this.appendChild(node.firstChild); return node; }
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      this.children.push(node); node.parent = this; return node;
    }
  };
}
const log = container();
const prompt = { dataset: {}, text: 'new prompt' };
const stream = { dataset: {}, text: 'live answer' };
log.appendChild(prompt); log.appendChild(stream);
const tools = new Map([['running', stream]]);
const pins = new WeakSet([stream]);
const context = {
  log, document: { createDocumentFragment() { return Object.assign(container(), { fragment: true }); } },
  autoScroll: false, renderingTranscript: false, loadedTranscriptOffset: 0,
  activeAssistantEl: stream, activeReasoningEl: null, activeStreamingToolEl: null,
  virtPinnedEls: pins, toolElements: tools,
  clearFindMarks() {}, addTranscriptLoader() {}, scheduleLogVirtualization() {},
  forceScrollToBottom() { throw Error('must preserve viewport'); },
  showEmptyState() { throw Error('must preserve live tail'); },
  addAssistantMsg(text) { log.appendChild({ dataset: {}, text }); }
};
vm.createContext(context);
vm.runInContext(script.slice(start, end), context);
context.renderTranscript([{ kind: 'assistant', text: 'older answer' }], true, true);
assert.equal(log.children[0].text, 'older answer');
assert.equal(log.children[1], prompt);
assert.equal(log.children[2], stream);
assert.equal(context.activeAssistantEl, stream);
assert.equal(tools.get('running'), stream);
assert.equal(context.virtPinnedEls, pins);
assert.equal(log.scrollTop, 120);
context.renderTranscript([], true, true);
assert.equal(log.children[2], stream);
assert.ok(script.includes('renderTranscript(older, true, true)'));
console.log('PASS: older-page prepend retains new prompt, streaming DOM, tool state and viewport, including empty pages');
