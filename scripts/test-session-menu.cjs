// Regression checks for the chat's right-click menu, against the cooked Webview code.
// Run: node scripts/test-session-menu.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('scripts/.burstcode-webview-script.js', 'utf8');

function element(children) {
  return {
    children, className: '', textContent: '', style: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { this.children.push(child); return child; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  };
}
// The menu and everything it reaches inside the Webview.
const start = script.indexOf('function showTabMenu(');
assert.ok(start >= 0, 'showTabMenu');
const end = script.indexOf('\nfunction ', start + 1);
const sent = [];
const closed = [];
const context = {
  document: { createElement: () => element([]), body: element([]) },
  window: { innerWidth: 1000, innerHeight: 800 },
  sessionsCache: { openIds: ['a', 'b'] },
  vscode: { postMessage: (msg) => sent.push(msg) },
  closeTabMenu: () => closed.push(true),
  requestAnimationFrame: (fn) => fn(),
  tabMenuEl: null
};
vm.createContext(context);
vm.runInContext(script.slice(start, end < 0 ? undefined : end), context);

function menuFor(session, isTab) {
  sent.length = 0;
  closed.length = 0;
  context.closeTabMenu = () => { closed.push(true); context.tabMenuEl = null; };
  context.showTabMenu({ clientX: 10, clientY: 10 }, session, isTab);
  return context.document.body.children.at(-1).children.map((el) => (el.className === 'sep' ? '|' : el.textContent));
}
const click = (session, isTab, label) => {
  context.showTabMenu({ clientX: 10, clientY: 10 }, session, isTab);
  const item = context.document.body.children.at(-1).children.find((el) => el.textContent === label);
  assert.ok(item, label);
  item.onclick();
};

// A tab: Stop run only while running, then Rename, then the tab actions and Delete.
assert.deepEqual(menuFor({ id: 'a', status: 'idle' }), ['Rename', '|', 'Close', 'Close Others', 'Close All', '|', 'Delete from history']);
assert.deepEqual(menuFor({ id: 'a', status: 'running' }), ['Stop run', '|', 'Rename', '|', 'Close', 'Close Others', 'Close All', '|', 'Delete from history']);
// An entry of the history overlay is not a tab, so the tab actions are left out.
assert.deepEqual(menuFor({ id: 'old', status: 'completed' }, false), ['Rename', '|', 'Delete from history']);
assert.deepEqual(menuFor({ id: 'old', status: 'running' }, false), ['Stop run', '|', 'Rename', '|', 'Delete from history']);

sent.length = 0;
click({ id: 'a', status: 'idle' }, true, 'Rename');
assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'rename-session', payload: { id: 'a' } }]);
assert.equal(context.tabMenuEl, null, 'the menu closes once an item is chosen');
sent.length = 0;
click({ id: 'old', status: 'completed' }, false, 'Rename');
assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ type: 'rename-session', payload: { id: 'old' } }]);

// History entries open that menu on right-click; tabs keep their own menu.
const renderHistory = script.slice(script.indexOf('function renderHistory('), script.indexOf('\nfunction renderLessons('));
assert.ok(renderHistory.includes("item.addEventListener('contextmenu'"), 'history entries react to right-click');
assert.ok(renderHistory.includes('showTabMenu(ev, s, false)'), 'without the tab-only actions');
const renderTabs = script.slice(script.indexOf('function renderTabs('), script.indexOf('function renderHistory('));
assert.ok(renderTabs.includes('showTabMenu(ev, s)'), 'tabs keep the full menu');
console.log('PASS: chat menu offers Rename on tabs and history entries, tab actions stay on tabs, Rename reaches the host');
