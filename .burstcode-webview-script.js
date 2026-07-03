

const vscode = acquireVsCodeApi();
const WORKSPACE_ROOT = "";
const log = document.getElementById('log');
const input = document.getElementById('input');
const attachmentsEl = document.getElementById('attachments');
const imagePreviewOverlay = document.getElementById('imagePreviewOverlay');
const imagePreviewStage = document.getElementById('imagePreviewStage');
const imagePreviewImg = document.getElementById('imagePreviewImg');
const imagePreviewZoomOut = document.getElementById('imagePreviewZoomOut');
const imagePreviewZoomIn = document.getElementById('imagePreviewZoomIn');
const imagePreviewReset = document.getElementById('imagePreviewReset');
const imagePreviewCopy = document.getElementById('imagePreviewCopy');
const imagePreviewClose = document.getElementById('imagePreviewClose');
const rulesToggle = document.getElementById('rulesToggle');
const skillsToggle = document.getElementById('skillsToggle');
const mcpToggle = document.getElementById('mcpToggle');
const attachImageInput = document.getElementById('attachImageInput');
const attachImageBtn = document.getElementById('attachImageBtn');
const sendBtn = document.getElementById('sendBtn');
const queueBtn = document.getElementById('queueBtn');
const newBtn = document.getElementById('newBtn');
const cfgBtn = document.getElementById('cfgBtn');
const modelPickerBtn = document.getElementById('modelPickerBtn');
const modelPicker = document.getElementById('modelPicker');
const ctxUsageEl = document.getElementById('ctxUsage');
const ctxUsagePctEl = ctxUsageEl.querySelector('.pct');
const ctxUsageTokensEl = ctxUsageEl.querySelector('.tokens');
const ctxUsageRingEl = ctxUsageEl.querySelector('.ring .fg');
const CTX_RING_CIRC = 2 * Math.PI * 9; // r=9 in viewBox
ctxUsageRingEl.setAttribute('stroke-dasharray', String(CTX_RING_CIRC));
ctxUsageRingEl.setAttribute('stroke-dashoffset', String(CTX_RING_CIRC));

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
  }
  return String(Math.round(n));
}

function setContextUsage(used, max) {
  const u = Number(used) || 0;
  const m = Number(max) || 0;
  const pct = m > 0 ? Math.max(0, Math.min(100, (u / m) * 100)) : 0;
  ctxUsagePctEl.textContent = Math.round(pct) + '%';
  ctxUsageTokensEl.textContent = fmtTokens(u) + '/' + fmtTokens(m);
  const offset = CTX_RING_CIRC * (1 - pct / 100);
  ctxUsageRingEl.setAttribute('stroke-dashoffset', String(offset));
  const level = pct >= 90 ? 'crit' : (pct >= 70 ? 'warn' : 'ok');
  ctxUsageEl.dataset.level = level;
  const tip = 'Context: ' + u.toLocaleString() + ' / ' + m.toLocaleString()
    + ' tokens (' + pct.toFixed(1) + '%)'
    + (pct >= 90 ? ' — auto-compressing...' : '');
  ctxUsageEl.title = tip;
}

const bgStatusEl = document.getElementById('bgStatus');
const bgStatusLabelEl = bgStatusEl.querySelector('.label');
function shortFile(p) {
  if (!p) return '';
  const s = String(p);
  // Avoid regexes (escape rules differ inside TS template literals).
  let cut = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '/' || ch === '\\') { cut = i; break; }
  }
  const base = cut >= 0 ? s.slice(cut + 1) : s;
  return base.length > 22 ? base.slice(0, 21) + '…' : base;
}
function setBgStatus(s) {
  if (!s || typeof s !== 'object') {
    bgStatusEl.dataset.phase = 'disabled';
    bgStatusLabelEl.textContent = 'BG off';
    bgStatusEl.title = 'Background explorer disabled — click to manage';
    return;
  }
  bgStatusEl.dataset.phase = s.phase || 'disabled';
  let label = 'BG ' + (s.phase || '');
  switch (s.phase) {
    case 'disabled': label = 'BG off'; break;
    case 'idle-waiting': label = 'BG idle'; break;
    case 'running': label = 'BG · ' + (shortFile(s.currentFile) || 'analysing…'); break;
    case 'paused-by-chat': label = 'BG paused (chat)'; break;
    case 'paused-by-activity': label = 'BG paused'; break;
    case 'no-workspace': label = 'BG (no folder)'; break;
    case 'error': label = 'BG error'; break;
  }
  bgStatusLabelEl.textContent = label;
  const testsLine = (s.testsRun > 0)
    ? ('Tests: ' + s.testsRun + ' run — ✓ ' + s.testsPassed + ' / ✗ ' + s.testsFailed + ' / – ' + s.testsSkipped)
    : ('Tests generated: ' + (s.testsGenerated || 0) + ' (auto-run off)');
  const recent = Array.isArray(s.recentActivity) ? s.recentActivity.slice(0, 3) : [];
  const NL = '\n';
  const recentTip = recent.length
    ? (NL + 'Recent:' + NL + recent.map((e) => '  · ' + new Date(e.ts).toLocaleTimeString() + ' ' + e.message).join(NL))
    : '';
  bgStatusEl.title =
    'Background explorer — ' + s.phase + NL +
    (s.detail || '') + NL +
    (s.currentFile ? 'Current: ' + s.currentFile + NL : '') +
    'Files analysed: ' + (s.filesProcessed || 0) + '  ·  Bugs: ' + (s.bugsFound || 0) + NL +
    testsLine +
    (s.modelLabel ? (NL + 'Model: ' + s.modelLabel) : '') +
    recentTip +
    NL + NL + 'Click for actions (open log, select model, toggle, run now).';
}
bgStatusEl.addEventListener('click', () => {
  vscode.postMessage({ type: 'bg-menu' });
});
const historyBtn = document.getElementById('historyBtn');
const historyEl = document.getElementById('history');
const tabsEl = document.getElementById('tabs');
const lessonsBtn = document.getElementById('lessonsBtn');
const lessonsEl = document.getElementById('lessons');
const planEl = document.getElementById('plan');
const rollbackOverlay = document.getElementById('rollbackOverlay');
const pendingBanner = document.getElementById('pendingBanner');
const pendingTitleRow = document.getElementById('pendingTitle');
const pendingTitle = pendingTitleRow.querySelector('.title-text');
const pendingSummary = pendingBanner.querySelector('.summary');
const pendingReviewBtn = document.getElementById('pendingReviewBtn');
const pendingAcceptBtn = document.getElementById('pendingAcceptBtn');
const pendingRejectBtn = document.getElementById('pendingRejectBtn');
const pendingFileList = document.getElementById('pendingFileList');
const statusEl = document.getElementById('status');
const statusDot = statusEl.querySelector('.dot');
const statusLabel = statusEl.querySelector('.label');
const statusElapsed = statusEl.querySelector('.elapsed');

let activeAssistantEl = null;
let activeStreamingToolEl = null; // the <details> element currently receiving arg-stream content
let activeReasoningEl = null;
let toolElements = new Map();
let runningTools = new Map(); // id -> { name, startedAt }
let busy = false;
let sessionsCache = { sessions: [], activeId: null, openIds: [] };
let lessonsCache = [];
let lessonsAdding = false;
let runStartedAt = 0;
let elapsedTimer = null;
let currentIter = 0;
let lastUserActivityPostAt = 0;

// Auto-follow scrolling. We only push the log to the bottom when the user
// is already (close to) at the bottom. As soon as the user scrolls up, we
// stop forcing scroll so they can read freely; once they come back to the
// bottom edge, auto-follow resumes.
let autoScroll = true;
let pendingScrollFrame = 0;
let pendingScrollForce = false;
let lastManualScrollAt = 0;
const SCROLL_BOTTOM_THRESHOLD = 48;
function isLogAtBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
}
function markManualScrollIntent() {
  lastManualScrollAt = Date.now();
}
let taskDoneUserActivityListening = false;
let taskDoneUserActivityWindowFocused = true;
const taskDoneUserActivityEvents = new Set();
function reportUserActivity(force) {
  const now = Date.now();
  if (!force && now - lastUserActivityPostAt < 500) return;
  lastUserActivityPostAt = now;
  vscode.postMessage({ type: 'user-activity' });
}
function reportTaskDoneUserActivity() {
  if (!taskDoneUserActivityListening || !taskDoneUserActivityWindowFocused) return;
  taskDoneUserActivityListening = false;
  vscode.postMessage({ type: 'user-activity' });
}
function stopTaskDoneUserActivityListener() {
  if (!taskDoneUserActivityEvents.size) return;
  for (const eventName of Array.from(taskDoneUserActivityEvents)) {
    window.removeEventListener(eventName, reportTaskDoneUserActivity, true);
    document.removeEventListener(eventName, reportTaskDoneUserActivity, true);
  }
  taskDoneUserActivityEvents.clear();
  taskDoneUserActivityListening = false;
}
	function startTaskDoneUserActivityListener(events, focused) {
	  stopTaskDoneUserActivityListener();
	  const names = Array.isArray(events) && events.length
	    ? events.map(String)
	    : ['pointermove', 'pointerdown', 'mousedown', 'click', 'keydown', 'input', 'focus', 'wheel', 'touchstart'];
	  taskDoneUserActivityWindowFocused = focused !== false;
	  taskDoneUserActivityListening = true;
	  for (const eventName of names) {
	    taskDoneUserActivityEvents.add(eventName);
	    window.addEventListener(eventName, reportTaskDoneUserActivity, true);
	    document.addEventListener(eventName, reportTaskDoneUserActivity, true);
	  }
	}
		const clientAlertTimers = new Map();
		let clientAlertAudioContext = null;
		let clientAlertUnlocked = false;
		function getClientAlertAudioContext() {
		  try {
		    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
		    if (!AudioContextCtor) return null;
		    if (!clientAlertAudioContext || clientAlertAudioContext.state === 'closed') {
		      clientAlertAudioContext = new AudioContextCtor();
		    }
		    return clientAlertAudioContext;
		  } catch (_) {
		    return null;
		  }
		}
		function unlockClientAlertAudio() {
		  const ctx = getClientAlertAudioContext();
		  if (!ctx) return;
		  try {
		    const p = ctx.resume && ctx.resume();
		    if (p && typeof p.then === 'function') {
		      p.then(() => { clientAlertUnlocked = ctx.state === 'running'; }, () => undefined);
		    } else {
		      clientAlertUnlocked = ctx.state === 'running';
		    }
		  } catch (_) {}
		}
		function playClientAlertSoundOnce(kind) {
		  try {
		    const ctx = getClientAlertAudioContext();
		    if (!ctx) return;
		    if (ctx.state === 'suspended') {
		      try { const p = ctx.resume && ctx.resume(); if (p && typeof p.catch === 'function') p.catch(() => undefined); } catch (_) {}
		    }
		    const now = ctx.currentTime + 0.03;
		    const freqs = kind === 'taskDone' ? [880, 1175] : [659, 659];
		    freqs.forEach((freq, idx) => {
		      const start = now + idx * 0.22;
		      const osc = ctx.createOscillator();
		      const gain = ctx.createGain();
		      osc.type = 'sine';
		      osc.frequency.value = freq;
		      gain.gain.setValueAtTime(0.0001, start);
		      gain.gain.exponentialRampToValueAtTime(kind === 'taskDone' ? 0.12 : 0.08, start + 0.02);
		      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
		      osc.connect(gain).connect(ctx.destination);
		      osc.start(start);
		      osc.stop(start + 0.2);
		    });
		  } catch (_) {
		    // Best effort: webview audio may be blocked until the user has interacted.
		  }
		}
		function startClientAlertSound(kind, intervalMs) {
		  stopClientAlertSound(kind);
		  unlockClientAlertAudio();
		  playClientAlertSoundOnce(kind);
		  const timer = setInterval(() => playClientAlertSoundOnce(kind), Math.max(250, Number(intervalMs) || 1000));
		  clientAlertTimers.set(kind, timer);
		}
		function stopClientAlertSound(kind) {
		  const timer = clientAlertTimers.get(kind);
		  if (timer) clearInterval(timer);
		  clientAlertTimers.delete(kind);
		}
		function showClientAttentionNotification(message) {
		  try {
		    if (!('Notification' in window)) return;
		    const title = 'BurstCode';
		    const body = String(message || 'BurstCode needs your attention.');
		    if (Notification.permission === 'granted') {
		      const n = new Notification(title, { body, silent: false });
		      n.onclick = () => { try { window.focus(); } catch (_) {} };
		    } else if (Notification.permission === 'default') {
		      Notification.requestPermission().then((permission) => {
		        if (permission !== 'granted') return;
		        const n = new Notification(title, { body, silent: false });
		        n.onclick = () => { try { window.focus(); } catch (_) {} };
		      }, () => undefined);
		    }
		  } catch (_) {
		    // Some VS Code webview hosts do not expose browser notifications.
		  }
		}
		['pointerdown', 'keydown', 'input', 'focus', 'click'].forEach((eventName) => {
		  window.addEventListener(eventName, unlockClientAlertAudio, true);
		  document.addEventListener(eventName, unlockClientAlertAudio, true);
		});
	['pointerdown', 'keydown', 'input', 'focus'].forEach((eventName) => {
	  document.addEventListener(eventName, () => reportUserActivity(false), true);
	});
// File-path and symbol link click delegation
document.addEventListener('click', (ev) => {
  const a = ev.target.closest && ev.target.closest('a[data-file-path], a[data-symbol-name]');
  if (!a) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (a.dataset.symbolName) {
    vscode.postMessage({ type: 'find-symbol', payload: { name: a.dataset.symbolName } });
  } else {
    const path = a.dataset.filePath || '';
    const line = parseInt(a.dataset.fileLine || '0', 10);
    if (path) vscode.postMessage({ type: 'open-file', payload: { path, line } });
  }
});
log.addEventListener('wheel', markManualScrollIntent, { passive: true });
log.addEventListener('touchmove', markManualScrollIntent, { passive: true });
log.addEventListener('pointerdown', markManualScrollIntent, { passive: true });
log.addEventListener('scroll', () => {
  const atBottom = isLogAtBottom();
  if (Date.now() - lastManualScrollAt < 800 || atBottom) autoScroll = atBottom;
}, { passive: true });
function scheduleScrollToBottom(force) {
  pendingScrollForce = pendingScrollForce || force;
  if (pendingScrollFrame) return;
  pendingScrollFrame = requestAnimationFrame(() => {
    pendingScrollFrame = 0;
    const didForce = pendingScrollForce;
    const shouldScroll = didForce || autoScroll;
    pendingScrollForce = false;
    if (!shouldScroll) return;
    // First pass: capture the current scrollHeight.
    const h0 = log.scrollHeight;
    log.scrollTop = h0;
    // Second pass (next frame): if scrollHeight grew, scroll again so the
    // bottom content is truly visible. This fixes the "scrollbar moved but
    // content didn't" race caused by async layout.
    requestAnimationFrame(() => {
      const h1 = log.scrollHeight;
      if (h1 > h0) log.scrollTop = h1;
      else if (didForce || autoScroll) log.scrollTop = log.scrollHeight;
      autoScroll = isLogAtBottom();
    });
  });
}
function scrollToBottom() {
  if (autoScroll) scheduleScrollToBottom(false);
}
function tcScrollableAtBottom(el) {
  return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
}
function preserveToolScrollableAutoScroll(det, root) {
  const nodes = [];
  if (root && root.matches && root.matches('.tc-code, .tool-progress-log, .tool-args-stream, pre')) nodes.push(root);
  if (root && root.querySelectorAll) nodes.push(...Array.from(root.querySelectorAll('.tc-code, .tool-progress-log, .tool-args-stream, pre')));
  const scrollables = Array.from(new Set(nodes)).filter((el) => el && el.scrollHeight > el.clientHeight);
  if (!scrollables.length) return;
  if (!det.dataset.tcPreviewAutoScroll) det.dataset.tcPreviewAutoScroll = 'true';
  const shouldFollow = det.dataset.tcPreviewAutoScroll !== 'false';
  for (const el of scrollables) {
    if (!el.dataset.tcAutoScrollBound) {
      el.dataset.tcAutoScrollBound = 'true';
      const markManual = () => { det.dataset.tcPreviewManualScrollAt = String(Date.now()); };
      el.addEventListener('wheel', markManual, { passive: true });
      el.addEventListener('touchmove', markManual, { passive: true });
      el.addEventListener('pointerdown', markManual, { passive: true });
      el.addEventListener('scroll', () => {
        const manualAt = Number(det.dataset.tcPreviewManualScrollAt || '0');
        const atBottom = tcScrollableAtBottom(el);
        if (Date.now() - manualAt < 800 || atBottom) {
          det.dataset.tcPreviewAutoScroll = atBottom ? 'true' : 'false';
        }
      }, { passive: true });
    }
    if (shouldFollow) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          if (det.dataset.tcPreviewAutoScroll !== 'false') el.scrollTop = el.scrollHeight;
        });
      });
    }
  }
}
function preserveStreamingPreviewAutoScroll(det, body) {
  preserveToolScrollableAutoScroll(det, body);
}
// When a streamed tool finishes, applyRichTool tears out the live preview and
// appends a freshly-built body — a brand-new scrollable whose scrollTop starts
// at 0, so the box visibly jumps to the top right as the user finishes watching
// it stream. Snapshot the live preview's scroll state BEFORE the swap so we can
// put the new body back where the old one was (bottom if the user was following,
// otherwise the same offset).
const TC_SCROLLABLE_SEL = '.tc-code, .tool-args-stream, .tool-progress-log, pre';
function captureToolScroll(det) {
  if (!det || !det.querySelector) return null;
  const el = det.querySelector(TC_SCROLLABLE_SEL);
  // Only meaningful when the element actually overflows; a non-scrolling box has
  // nothing to preserve (and reads as scrollTop 0 either way).
  if (!el || el.scrollHeight <= el.clientHeight + 1) return null;
  return { atBottom: tcScrollableAtBottom(el), scrollTop: el.scrollTop };
}
function restoreToolScroll(det, snap) {
  if (!det || !snap || !det.querySelector) return;
  // Double rAF: the new body's layout (and final scrollHeight) isn't settled in
  // the frame it was appended, mirroring scheduleScrollToBottom's two-pass fix.
  const apply = () => {
    const el = det.querySelector(TC_SCROLLABLE_SEL);
    if (!el) return;
    el.scrollTop = snap.atBottom ? el.scrollHeight : Math.min(snap.scrollTop, el.scrollHeight);
  };
  requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
}
function forceScrollToBottom() {
  autoScroll = true;
  scheduleScrollToBottom(true);
}
// Capture the assistant element AT SCHEDULE TIME. The previous version read the
// global activeAssistantEl inside the rAF callback, so if the turn ended
// (assistant-message sets it to null) or a new turn started a new bubble before
// the frame fired, the queued render either silently dropped the final tokens or
// wrote markdown into the WRONG bubble -- producing the interleaved/torn output
// that only a full session re-render (renderTranscript) could repair. Now each
// target element carries its own pending flag and the callback renders exactly
// the element it was scheduled for.
function scheduleRender(targetEl) {
  const el = targetEl || activeAssistantEl;
  if (!el) return;
  if (el.dataset.renderPending === 'true') return;
  el.dataset.renderPending = 'true';
  requestAnimationFrame(() => {
    delete el.dataset.renderPending;
    // The element may have been removed from the DOM (e.g. empty turn pruned).
    if (!el.isConnected) return;
    const raw = el.dataset.raw || '';
    const mdEl = el.querySelector('.md');
    if (mdEl) {
      mdEl.innerHTML = renderMarkdown(raw);
      bindCodeCopy(mdEl);
    }
    scheduleScrollToBottom(false);
  });
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + 'm' + (r < 10 ? '0' : '') + r + 's';
}

function refreshElapsed() {
  if (!runStartedAt) { statusElapsed.textContent = ''; return; }
  statusElapsed.textContent = fmtElapsed(Date.now() - runStartedAt);
}

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusLabel.textContent = label;
  // Hide status row entirely when idle to keep the UI clean.
  statusEl.dataset.active = state === 'idle' ? 'false' : 'true';
  if (state === 'idle' || state === 'done' || state === 'error') {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    if (state === 'idle') { runStartedAt = 0; statusElapsed.textContent = ''; }
    else { refreshElapsed(); }
  } else {
    if (!runStartedAt) runStartedAt = Date.now();
    if (!elapsedTimer) elapsedTimer = setInterval(refreshElapsed, 1000);
    refreshElapsed();
  }
}

// Collapse state persists across plan updates within a session so the user's
// preference isn't reset every time the model edits the plan.
let planCollapsed = false;
function renderPlan(steps) {
  if (!steps || steps.length === 0) {
    planEl.classList.remove('has-steps');
    planEl.innerHTML = '';
    return;
  }
  planEl.classList.add('has-steps');
  planEl.classList.toggle('collapsed', planCollapsed);
  const done = steps.filter((s) => s.status === 'completed').length;

  const title = document.createElement('div');
  title.className = 'plan-title';
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');
  title.setAttribute('aria-expanded', String(!planCollapsed));
  title.title = planCollapsed ? 'Expand plan' : 'Collapse plan';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▾';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Plan · ' + done + '/' + steps.length;
  title.appendChild(chev);
  title.appendChild(label);
  const togglePlan = () => {
    planCollapsed = !planCollapsed;
    planEl.classList.toggle('collapsed', planCollapsed);
    title.setAttribute('aria-expanded', String(!planCollapsed));
    title.title = planCollapsed ? 'Expand plan' : 'Collapse plan';
  };
  title.addEventListener('click', togglePlan);
  title.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      togglePlan();
    }
  });

  const body = document.createElement('div');
  body.className = 'plan-body';
  const ol = document.createElement('ol');
  steps.forEach((s) => {
    const li = document.createElement('li');
    li.className = s.status;
    const icon = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : '○';
    const iconEl = document.createElement('span');
    iconEl.className = 'icon';
    iconEl.textContent = icon;
    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = s.content;
    li.appendChild(iconEl);
    li.appendChild(document.createTextNode(' '));
    li.appendChild(textEl);
    ol.appendChild(li);
  });
  body.appendChild(ol);

  planEl.innerHTML = '';
  planEl.appendChild(title);
  planEl.appendChild(body);
}

function clearEmptyState() {
  const es = log.querySelector('.empty-state');
  if (es) es.remove();
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderPendingBanner(state) {
  const files = (state && state.files) || 0;
  const hunks = (state && state.hunks) || 0;
  const fileList = (state && Array.isArray(state.fileList)) ? state.fileList : [];
  if (hunks === 0 || files === 0) {
    pendingBanner.classList.remove('visible');
    return;
  }
  pendingBanner.classList.add('visible');
  // Re-enable the action buttons in case they were disabled by a prior click.
  pendingAcceptBtn.disabled = false;
  pendingRejectBtn.disabled = false;
  pendingTitle.textContent = hunks + ' pending edit' + (hunks === 1 ? '' : 's')
    + ' across ' + files + ' file' + (files === 1 ? '' : 's');
  pendingSummary.textContent = state.latestSummary || '';
  pendingSummary.style.display = state.latestSummary ? '' : 'none';
  renderPendingFileList(fileList);
}

function renderPendingFileList(fileList) {
  pendingFileList.innerHTML = '';
  if (!fileList.length) return;
  fileList.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.title = 'Click to open the diff for ' + f.path;

    const fname = document.createElement('div');
    fname.className = 'fname';
    const base = document.createElement('span');
    base.className = 'basename';
    base.textContent = f.name || f.path;
    fname.appendChild(base);
    // Show parent directory dimmed if the path is more than just a basename.
    const slashIdx = (f.path || '').lastIndexOf('/');
    if (slashIdx > 0) {
      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = f.path.slice(0, slashIdx);
      fname.appendChild(dir);
    }
    row.appendChild(fname);

    if (f.isNewFile) {
      const newBadge = document.createElement('span');
      newBadge.className = 'badge new';
      newBadge.textContent = 'new';
      row.appendChild(newBadge);
    }
    if (f.pendingHunks > 0) {
      const b = document.createElement('span');
      b.className = 'badge pending';
      b.textContent = f.pendingHunks + ' pending';
      row.appendChild(b);
    } else if ((f.acceptedHunks || 0) + (f.rejectedHunks || 0) > 0) {
      const b = document.createElement('span');
      b.className = 'badge done';
      b.textContent = 'decided';
      row.appendChild(b);
    }

    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'review-edits', payload: { uri: f.uri } });
    });
    pendingFileList.appendChild(row);
  });
}

// Floating right-click menu for tabs. Only one is alive at a time; the
// closure tracks the current node and we wire global listeners ONCE.
let tabMenuEl = null;
function closeTabMenu() {
  if (tabMenuEl && tabMenuEl.parentNode) tabMenuEl.parentNode.removeChild(tabMenuEl);
  tabMenuEl = null;
}
// Outside-click dismiss. Capture phase so it runs before any other handler
// that might prevent default / stop propagation.
document.addEventListener('mousedown', (ev) => {
  if (!tabMenuEl) return;
  if (!tabMenuEl.contains(ev.target)) closeTabMenu();
}, true);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && tabMenuEl) closeTabMenu();
}, true);
// Also close on scroll / resize — the anchor would otherwise drift.
window.addEventListener('scroll', closeTabMenu, true);
window.addEventListener('resize', closeTabMenu);

function showTabMenu(ev, s) {
  closeTabMenu();
  const openCount = (sessionsCache.openIds || []).length;
  // Build the item list dynamically so we can inject status-specific actions
  // (e.g. "Stop run") only when they make sense.
  const items = [];
  if (s.status === 'running') {
    items.push({ label: 'Stop run', action: () => vscode.postMessage({ type: 'cancel-session', payload: { id: s.id } }) });
    items.push({ kind: 'sep' });
  }
  items.push({ label: 'Close', action: () => vscode.postMessage({ type: 'close-tab', payload: { id: s.id } }) });
  items.push({
    label: 'Close Others',
    disabled: openCount <= 1,
    action: () => vscode.postMessage({ type: 'close-other-tabs', payload: { id: s.id } })
  });
  items.push({ label: 'Close All', danger: true, action: () => vscode.postMessage({ type: 'close-all-tabs' }) });
  items.push({ kind: 'sep' });
  items.push({
    label: 'Delete from history',
    danger: true,
    disabled: s.status === 'running',
    // Backend pops a VS Code modal to confirm — webview confirm() is a
    // no-op in vscode webviews so we cannot guard the action here.
    action: () => vscode.postMessage({ type: 'delete-session', payload: { id: s.id } })
  });

  const menu = document.createElement('div');
  menu.className = 'tab-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.kind === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    el.setAttribute('role', 'menuitem');
    el.textContent = it.label;
    el.onclick = () => {
      if (it.disabled) return;
      closeTabMenu();
      try { it.action(); } catch (_) { /* swallow — menu must not leak */ }
    };
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  tabMenuEl = menu;
  // Position at the cursor, then nudge inside the viewport on next frame.
  menu.style.left = ev.clientX + 'px';
  menu.style.top = ev.clientY + 'px';
  requestAnimationFrame(() => {
    if (!tabMenuEl) return;
    const r = tabMenuEl.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) tabMenuEl.style.left = (window.innerWidth - r.width - 6) + 'px';
    if (r.bottom > window.innerHeight - 4) tabMenuEl.style.top = (window.innerHeight - r.height - 6) + 'px';
  });
}

// Render the horizontal session-tab strip below the topbar. Each tab shows
// the session's title, a status-colored dot, and a close (×) button. The
// active session is highlighted with a stronger gradient + flush bottom edge
// so it reads as the foreground tab. Tabs are kept in sync with the history
// list (so they share the same data shape and ordering).
function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  const list = sessionsCache.sessions || [];
  // Browser-style working set: the tab strip ONLY shows sessions the user
  // has explicitly opened (via clicking a history item, creating a new chat,
  // or sending a prompt). The full archive lives in the history overlay.
  const openIds = new Set(sessionsCache.openIds || []);
  const visible = list.filter((s) => openIds.has(s.id));
  // Stable ordering by creation time so opening/closing a tab doesn't
  // shuffle the others around.
  visible.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  visible.forEach((s) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.state = String(s.status || 'idle');
    const isActive = s.id === sessionsCache.activeId;
    tab.dataset.active = String(isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.title = s.title + (s.status && s.status !== 'idle' ? ' · ' + s.status : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Close tab (chat stays in history)';
    close.innerHTML = '×';
    // Close → just remove from the working set. Does NOT delete the
    // session and does NOT cancel an in-flight run; users can re-open from
    // history, and stopping a run is done via the chat panel's Stop button.
    close.onclick = (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'close-tab', payload: { id: s.id } });
    };
    // Middle-click also closes the tab (browser convention).
    tab.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        vscode.postMessage({ type: 'close-tab', payload: { id: s.id } });
      }
    });
    // Right-click → floating context menu (Close / Close Others / Close All / …).
    tab.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showTabMenu(ev, s);
    });
    tab.appendChild(dot);
    tab.appendChild(title);
    tab.appendChild(close);
    tab.onclick = () => {
      if (isActive) return;
      vscode.postMessage({ type: 'load-session', payload: { id: s.id } });
    };
    tabsEl.appendChild(tab);
  });
  // (No trailing "+" inside the strip — the New chat icon lives in the
  // topbar's action-icon cluster, just to the left of the history button.)
  // Auto-scroll the active tab into view so switching via history doesn't
  // leave it clipped offscreen.
  const activeEl = tabsEl.querySelector('.tab[data-active="true"]');
  if (activeEl && typeof activeEl.scrollIntoView === 'function') {
    activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function renderHistory() {
  historyEl.innerHTML = '';
  const list = sessionsCache.sessions || [];
  if (list.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No saved chats yet.';
    historyEl.appendChild(e);
    return;
  }
  const STATUS_LABELS = {
    running: 'Running',
    completed: 'Done',
    stopped: 'Stopped',
    error: 'Error',
    idle: ''
  };
  list.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'item' + (s.id === sessionsCache.activeId ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = s.title;
    // Status badge — only rendered for non-trivial states. Idle sessions
    // keep the list visually quiet.
    const state = String(s.status || 'idle');
    if (state !== 'idle') {
      const badge = document.createElement('span');
      badge.className = 'status';
      badge.dataset.state = state;
      const dot = document.createElement('span');
      dot.className = 'dot';
      const lbl = document.createElement('span');
      lbl.textContent = STATUS_LABELS[state] || state;
      badge.appendChild(dot);
      badge.appendChild(lbl);
      item.appendChild(badge);
    }
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(s.updatedAt);
    // Per-row stop button — only meaningful while running. Stays in the
    // DOM but hidden otherwise so layout doesn't jump on state transitions.
    const stop = document.createElement('button');
    stop.className = 'stop';
    stop.title = 'Stop this run';
    stop.innerHTML = '<svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>';
    stop.style.display = state === 'running' ? '' : 'none';
    stop.onclick = (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'cancel-session', payload: { id: s.id } });
    };
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    // Backend pops a VS Code modal to confirm; webview confirm() is a no-op
    // inside vscode webviews so we just fire the intent and let the host
    // gate it with a native dialog.
    del.onclick = (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'delete-session', payload: { id: s.id } });
    };
    item.appendChild(title);
    item.appendChild(time);
    item.appendChild(stop);
    item.appendChild(del);
    item.onclick = () => {
      vscode.postMessage({ type: 'load-session', payload: { id: s.id } });
      historyEl.classList.remove('open');
    };
    historyEl.appendChild(item);
  });
}

function renderLessons() {
  lessonsEl.innerHTML = '';

  // Header (always visible)
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = 'Lessons';
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = '(' + lessonsCache.length + ')';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const addBtn = document.createElement('button');
  addBtn.className = 'add';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add';
  addBtn.title = 'Manually add a lesson';
  addBtn.onclick = () => { lessonsAdding = true; renderLessons(); };
  const clearBtn = document.createElement('button');
  clearBtn.className = 'clear';
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear all';
  clearBtn.title = 'Delete every lesson';
  clearBtn.disabled = lessonsCache.length === 0;
  if (lessonsCache.length === 0) clearBtn.style.opacity = '0.35';
  clearBtn.onclick = () => {
    if (lessonsCache.length === 0) return;
    // Backend confirms via VS Code modal (webview confirm() is a no-op).
    vscode.postMessage({ type: 'clear-lessons' });
  };
  head.appendChild(title);
  head.appendChild(count);
  head.appendChild(spacer);
  head.appendChild(addBtn);
  head.appendChild(clearBtn);
  lessonsEl.appendChild(head);

  // Inline editor (when adding a brand-new lesson)
  if (lessonsAdding) {
    lessonsEl.appendChild(buildLessonEditor(null));
  }

  // List — split into Critical Rules (important=true) then Scoped lessons.
  if (lessonsCache.length === 0 && !lessonsAdding) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = 'No lessons yet.<br>BurstCode will record one whenever you correct it,<br>or when you state a project-wide rule.';
    lessonsEl.appendChild(e);
    return;
  }

  const important = lessonsCache.filter((l) => l && l.important);
  const scoped = lessonsCache.filter((l) => !l || !l.important);

  if (important.length > 0) {
    const head = document.createElement('div');
    head.className = 'section-head critical';
    head.textContent = '★ Critical rules — always apply';
    lessonsEl.appendChild(head);
    important.forEach((l) => lessonsEl.appendChild(buildLessonRow(l)));
  }
  if (scoped.length > 0) {
    const head = document.createElement('div');
    head.className = 'section-head';
    head.textContent = important.length > 0 ? 'Scoped lessons' : 'Lessons';
    lessonsEl.appendChild(head);
    scoped.forEach((l) => lessonsEl.appendChild(buildLessonRow(l)));
  }
}

function buildLessonRow(l) {
  const row = document.createElement('div');
  row.className = 'lesson' + (l.important ? ' important' : '');
  row.dataset.id = l.id;

  const top = document.createElement('div');
  top.className = 'row1';

  // Star toggle: flip important flag with one click.
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'star-btn' + (l.important ? ' on' : '');
  star.title = l.important
    ? 'Critical rule — click to demote to scoped lesson'
    : 'Promote to critical rule (always-apply, never truncated)';
  star.textContent = l.important ? '★' : '☆';
  star.onclick = (ev) => {
    ev.stopPropagation();
    vscode.postMessage({
      type: 'update-lesson',
      payload: {
        id: l.id,
        file: l.scope && l.scope.file,
        symbol: l.scope && l.scope.symbol,
        tags: l.scope && l.scope.tags,
        content: l.content,
        important: !l.important
      }
    });
  };
  top.appendChild(star);

  const idEl = document.createElement('span');
  idEl.className = 'id';
  idEl.textContent = l.id;
  top.appendChild(idEl);

  const sc = l.scope || {};
  if (sc.file) {
    const b = document.createElement('span');
    b.className = 'badge file';
    b.textContent = sc.file;
    b.title = 'file: ' + sc.file;
    top.appendChild(b);
  }
  if (sc.symbol) {
    const b = document.createElement('span');
    b.className = 'badge symbol';
    b.textContent = sc.symbol;
    b.title = 'symbol: ' + sc.symbol;
    top.appendChild(b);
  }
  if (Array.isArray(sc.tags)) {
    sc.tags.forEach((t) => {
      const b = document.createElement('span');
      b.className = 'badge tag';
      b.textContent = '#' + t;
      top.appendChild(b);
    });
  }
  if (!sc.file && !sc.symbol && (!sc.tags || !sc.tags.length)) {
    const b = document.createElement('span');
    b.className = 'badge global';
    b.textContent = 'global';
    top.appendChild(b);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  editBtn.onclick = () => {
    // Replace this row with an inline editor for this lesson.
    const editor = buildLessonEditor(l);
    row.replaceWith(editor);
  };
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'del';
  delBtn.textContent = 'Delete';
  delBtn.onclick = () => {
    // Backend confirms via VS Code modal (webview confirm() is a no-op).
    vscode.postMessage({ type: 'delete-lesson', payload: { id: l.id } });
  };
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  top.appendChild(actions);
  row.appendChild(top);

  const content = document.createElement('div');
  content.className = 'content';
  content.textContent = l.content;
  content.title = 'Double-click to edit';
  content.ondblclick = () => {
    const editor = buildLessonEditor(l);
    row.replaceWith(editor);
  };
  row.appendChild(content);

  if (l.updatedAt) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const ts = new Date(l.updatedAt);
    meta.textContent = 'updated ' + ts.toLocaleString();
    if (typeof l.hits === 'number' && l.hits > 0) meta.textContent += ' · ' + l.hits + ' hit' + (l.hits === 1 ? '' : 's');
    row.appendChild(meta);
  }

  return row;
}

function buildLessonEditor(existing) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const row = document.createElement('div');
  row.className = 'row';
  const fileInput = document.createElement('input');
  fileInput.type = 'text';
  fileInput.placeholder = 'file (optional, e.g. src/agent/AgentLoop.ts)';
  fileInput.value = (existing && existing.scope && existing.scope.file) || '';
  const symbolInput = document.createElement('input');
  symbolInput.type = 'text';
  symbolInput.placeholder = 'symbol (optional)';
  symbolInput.value = (existing && existing.scope && existing.scope.symbol) || '';
  row.appendChild(fileInput);
  row.appendChild(symbolInput);
  wrap.appendChild(row);

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.placeholder = 'tags (comma-separated, optional)';
  tagsInput.value = (existing && existing.scope && Array.isArray(existing.scope.tags)) ? existing.scope.tags.join(', ') : '';
  wrap.appendChild(tagsInput);

  const contentInput = document.createElement('textarea');
  contentInput.placeholder = 'Lesson — one imperative sentence (e.g. "Always pass the cancellation token last.")';
  contentInput.value = (existing && existing.content) || '';
  wrap.appendChild(contentInput);

  // Important / always-apply toggle.
  const impLabel = document.createElement('label');
  impLabel.className = 'important-row';
  const impInput = document.createElement('input');
  impInput.type = 'checkbox';
  impInput.checked = !!(existing && existing.important);
  const impText = document.createElement('span');
  impText.textContent = '★ Critical rule (always apply, included in every run)';
  const impHint = document.createElement('span');
  impHint.className = 'hint';
  impHint.textContent = '— pin even when no file matches';
  impLabel.appendChild(impInput);
  impLabel.appendChild(impText);
  impLabel.appendChild(impHint);
  wrap.appendChild(impLabel);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { lessonsAdding = false; renderLessons(); };
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'save';
  save.textContent = existing ? 'Save' : 'Add';
  save.onclick = () => {
    const content = contentInput.value.trim();
    if (!content) {
      contentInput.style.borderColor = 'var(--vscode-errorForeground)';
      contentInput.focus();
      return;
    }
    const tags = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
    vscode.postMessage({
      type: 'update-lesson',
      payload: {
        id: existing ? existing.id : undefined,
        file: fileInput.value.trim() || undefined,
        symbol: symbolInput.value.trim() || undefined,
        tags: tags.length ? tags : undefined,
        content,
        important: impInput.checked
      }
    });
    lessonsAdding = false;
    // The host will broadcast a fresh "lessons" payload that triggers a re-render.
  };
  actions.appendChild(cancel);
  actions.appendChild(save);
  wrap.appendChild(actions);

  // Focus the most useful input.
  setTimeout(() => contentInput.focus(), 0);
  return wrap;
}

function renderTranscript(entries) {
  log.innerHTML = '';
  toolElements.clear();
  activeAssistantEl = null;
  activeReasoningEl = null;
  activeStreamingToolEl = null;
  if (!entries || entries.length === 0) {
    showEmptyState();
    return;
  }
  entries.forEach((e) => {
    if (e.kind === 'user') addUserMsg(e.text, e.messageIndex, e.checkpointRef, undefined, e.imageCount, e.imageUrls);
    else if (e.kind === 'assistant') addAssistantMsg(e.text);
    else if (e.kind === 'reasoning') addReasoningMsg(e.text, { open: false, streaming: false });
    else if (e.kind === 'tool') {
      const det = document.createElement('details');
      det.className = 'tool';
      det.dataset.error = String(!!e.isError);
      const sum = document.createElement('summary');
      sum.textContent = (e.isError ? '⚠ ' : '✓ ') + (e.name || 'tool');
      det.appendChild(sum);
      log.appendChild(det);
      // Rebuild the rich card (diff / read / collect) when we still have the
      // call args from the saved transcript. Falls back to a plain <pre> dump
      // for everything else or when applyRichTool can't build a body.
      const handled = (e.name && e.args != null)
        ? applyRichTool(det, e.name, e.args, null, e.text, !!e.isError, true)
        : false;
      const hasBody = det.querySelector('.tc-file, .tc-code, pre');
      if (!handled || !hasBody) {
        const pre = document.createElement('pre');
        pre.textContent = (e.text || '').slice(0, 4000);
        det.appendChild(pre);
      }
    }
  });
  forceScrollToBottom();
}

// Re-hydrate the in-flight UI state from a backend snapshot. Called when the
// user switches BACK to a session whose agent run is still active. The
// transcript is already rendered by load-session at this point.
function replayLiveState(snap) {
  clearEmptyState();
  // Only render pills for the CURRENT (last) iteration. Historical iter pills
  // are interleaved with transcript content during a live run but their
  // corresponding messages are already shown by renderTranscript — appending
  // all pills here would place them out of order (below all finalized content).
  const pills = Array.isArray(snap.pills) ? snap.pills : [];
  let lastIterIdx = -1;
  for (let i = pills.length - 1; i >= 0; i--) {
    if (pills[i].kind === 'iteration') { lastIterIdx = i; break; }
  }
  const currentPills = lastIterIdx >= 0 ? pills.slice(lastIterIdx) : pills;
  for (const p of currentPills) {
    if (p.kind === 'iteration') {
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      const iter = (p.payload && p.payload.iter !== undefined) ? p.payload.iter : 0;
      pill.innerHTML = '<span class="pill">iter ' + (iter + 1) + '</span>';
      log.appendChild(pill);
    } else if (p.kind === 'auto-continue') {
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      const count = (p.payload && p.payload.count) || 1;
      const max = (p.payload && p.payload.max) || 1;
      pill.innerHTML = '<span class="pill">↻ auto-continue ' + count + '/' + max + '</span>';
      log.appendChild(pill);
    } else if (p.kind === 'auto-resume') {
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      const attempt = (p.payload && p.payload.attempt) || 1;
      const max = (p.payload && p.payload.max) || 1;
      pill.innerHTML = '<span class="pill">↻ auto-resume ' + attempt + '/' + max + '</span>';
      log.appendChild(pill);
    }
  }
  // In-flight reasoning bubble.
  if (snap.reasoningText) {
    activeReasoningEl = addReasoningMsg(snap.reasoningText, { open: true, streaming: true });
  }
  // Assistant segments finalized earlier in THIS iteration (e.g. each part
  // before a finish_reason=length auto-continue). Render them as completed
  // bubbles so none are lost — only the last segment is still streaming.
  const finalized = Array.isArray(snap.finalizedAssistantTexts) ? snap.finalizedAssistantTexts : [];
  for (const t of finalized) {
    if (t && t.trim().length > 0) addAssistantMsg(t);
  }
  // In-flight assistant bubble.
  if (snap.assistantText) {
    activeAssistantEl = addAssistantMsg(snap.assistantText);
  }
  // Running tools — rebuild each as an open details element.
  const tools = Array.isArray(snap.runningTools) ? snap.runningTools : [];
  for (const t of tools) {
    const det = document.createElement('details');
    det.className = 'tool';
    det.dataset.running = 'true';
    det.open = false;
    const sum = document.createElement('summary');
    let argSnippet = '';
    try { argSnippet = JSON.stringify(t.args).slice(0, 200); } catch (_) { argSnippet = ''; }
    sum.textContent = '🔧 ' + t.name + '(' + argSnippet + ') · running...';
    det.appendChild(sum);
    if (Array.isArray(t.progress) && t.progress.length) {
      const progPre = document.createElement('pre');
      progPre.className = 'tool-progress-log';
      progPre.textContent = t.progress.join('\n');
      if (progPre.textContent.length > 8000) {
        progPre.textContent = '...' + progPre.textContent.slice(-7500);
      }
      det.appendChild(progPre);
      det.open = true;
    }
    log.appendChild(det);
    toolElements.set(t.id, det);
    runningTools.set(t.id, { name: t.name, startedAt: t.startedAt || Date.now() });
  }
  currentIter = Number(snap.iter || 0);
  // Pending ask-user prompt (if any).
  if (snap.pendingAsk && snap.pendingAsk.id) {
    window.postMessage({ type: 'ask-user', payload: snap.pendingAsk }, '*');
  }
  setBusy(true);
  if (snap.lastStatus) {
    setStatus(snap.lastStatus.state || 'busy', snap.lastStatus.label || 'Running...');
  } else {
    setStatus('busy', currentIter ? 'Resuming iter ' + currentIter + '...' : 'Resuming...');
  }
  forceScrollToBottom();
}

// ============== Minimal markdown renderer ==============
// Handles fenced code blocks, inline code, headings, lists, blockquotes,
// horizontal rules, links, bold/italic and tables. HTML-escapes everything
// before reintroducing only the safe markup we recognize, so untrusted model
// output cannot inject scripts.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function cssAttrEscape(s) {
  return (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(String(s)) : String(s);
}

// ---- Rich tool-call rendering --------------------------------------------
// propose_edit / write_file render as a diff/code editor, read_file /
// collect_context render as "which lines were read" cards. Anything else
// falls back to the plain <pre> result dump.

function tcBaseName(p) {
  const s = String(p || '');
  const m = s.replace(/\\/g, '/').split('/');
  return m[m.length - 1] || s;
}

function tcFileLink(path, line, opts) {
  const a = document.createElement('span');
  a.className = 'tc-file-name';
  a.textContent = tcBaseName(path) + (line ? ':' + line : '');
  // propose_edit cards open the accept/reject diff editor (and jump to the
  // nearest change); other cards just open the file at the given line.
  const review = !!(opts && opts.review);
  a.title = review
    ? '查看改动 (diff · 接受/拒绝) — ' + String(path || '')
    : String(path || '');
  if (review) a.classList.add('tc-file-name-review');
  a.addEventListener('click', () => {
    if (!path) return;
    if (review) {
      vscode.postMessage({ type: 'review-edit-file', payload: { path: path, line: line || 0 } });
    } else {
      vscode.postMessage({ type: 'open-file', payload: { path: path, line: line || 0 } });
    }
  });
  return a;
}

// Minimal LCS-based line diff between two strings. Returns rows:
// { kind: 'ctx'|'add'|'del', oldNo, newNo, text }.
function tcLineDiff(oldStr, newStr, startLine) {
  const a = (oldStr == null ? '' : String(oldStr)).split('\n');
  const b = (newStr == null ? '' : String(newStr)).split('\n');
  if (oldStr == null || oldStr === '') {
    // Pure insertion (e.g. new file).
    return b.map((t, i) => ({ kind: 'add', oldNo: null, newNo: (startLine || 1) + i, text: t }));
  }
  const n = a.length, m = b.length;
  // Cap the DP table to keep big edits cheap; fall back to block replace.
  if (n * m > 250000) {
    const rows = [];
    a.forEach((t, i) => rows.push({ kind: 'del', oldNo: (startLine || 1) + i, newNo: null, text: t }));
    b.forEach((t, i) => rows.push({ kind: 'add', oldNo: null, newNo: (startLine || 1) + i, text: t }));
    return rows;
  }
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0, oldNo = startLine || 1, newNo = startLine || 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: a[i] }); i++; }
    else { rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: b[j] }); j++; }
  }
  while (i < n) rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: a[i++] });
  while (j < m) rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: b[j++] });
  return rows;
}

function tcCodeBlock(rows, mode) {
  // mode: 'diff' colours add/del; 'plain' just shows numbered lines.
  const code = document.createElement('div');
  code.className = 'tc-code';
  if (!rows.length) {
    const e = document.createElement('div');
    e.className = 'tc-empty';
    e.textContent = '(empty)';
    code.appendChild(e);
    return code;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tc-row ' + (mode === 'diff' ? r.kind : 'ctx');
    const ln = document.createElement('span');
    ln.className = 'tc-ln';
    ln.textContent = mode === 'diff'
      ? String(r.kind === 'add' ? r.newNo : r.kind === 'del' ? r.oldNo : r.newNo)
      : String(r.newNo);
    const txt = document.createElement('span');
    txt.className = 'tc-txt';
    txt.textContent = r.text;
    row.appendChild(ln);
    row.appendChild(txt);
    code.appendChild(row);
  }
  return code;
}

function tcFileCard(path, line, metaText, body, opts) {
  const card = document.createElement('div');
  card.className = 'tc-file';
  const head = document.createElement('div');
  head.className = 'tc-file-head';
  head.appendChild(tcFileLink(path, line, opts));
  if (metaText) {
    const meta = document.createElement('span');
    meta.className = 'tc-file-meta';
    meta.textContent = metaText;
    head.appendChild(meta);
  }
  card.appendChild(head);
  if (body) card.appendChild(body);
  return card;
}

// Returns an HTML summary string for the collapsed title, or '' to keep the
// default. name/args available at start; meta/result available at end.
function tcSummaryHtml(name, args, meta, isError, done) {
  const a = args || {};
  const tick = done ? (isError ? '⚠ ' : '') : '';
  if (name === 'propose_edit') {
    let adds = 0, dels = 0, files = [];
    const edits = tcProposePreviewEdits(a, meta);
    for (const e of edits) {
      if (e && e.path) files.push(tcBaseName(e.path));
      if (e && e.__lineRangePending) {
        if (e.__operation === 'replace_lines') {
          const repl = String(e.newText == null ? '' : e.newText);
          adds += repl === '' ? 0 : repl.split('\n').filter((_, idx, arr) => !(idx === arr.length - 1 && repl.endsWith('\n'))).length;
        }
        if (Number.isFinite(Number(e.endLine)) && Number.isFinite(Number(e.startLine)) && Number(e.startLine) <= Number(e.endLine)) {
          dels += Number(e.endLine) - Number(e.startLine) + 1;
        }
        continue;
      }
      const rows = tcLineDiff(e && e.oldText, e && e.newText, e && e.startLine);
      for (const r of rows) { if (r.kind === 'add') adds++; else if (r.kind === 'del') dels++; }
    }
    const uniq = Array.from(new Set(files));
    const label = uniq.length === 1 ? uniq[0] : (uniq.length + ' files');
    return tick + '<span class="tc-tag">✏️ Edit</span> <span class="tc-path">' + escapeHtml(label) + '</span>'
      + '<span class="tc-stat"><span class="tc-add">+' + adds + '</span> <span class="tc-del">-' + dels + '</span></span>';
  }
  if (name === 'write_file') {
    const created = meta && typeof meta.created === 'boolean' ? meta.created : undefined;
    const verb = created === true ? '新建' : created === false ? '覆写' : '写入';
    const sz = meta && meta.bytes != null ? ' · ' + tcBytes(meta.bytes) : '';
    return tick + '<span class="tc-tag">📝 Write</span> <span class="tc-path">' + escapeHtml(tcBaseName(a.path)) + '</span>'
      + '<span class="tc-stat">' + verb + sz + '</span>';
  }
  if (name === 'read_file') {
    const s = a.startLine, e = a.endLine;
    const rng = (s != null || e != null) ? ':' + (s || 1) + (e != null ? '-' + e : '+') : '';
    return tick + '<span class="tc-tag">📖 Read</span> <span class="tc-path">' + escapeHtml(tcBaseName(a.path) + rng) + '</span>';
  }
  if (name === 'collect_context') {
    const nf = Array.isArray(a.files) ? a.files.length : 0;
    const ng = Array.isArray(a.searches) ? a.searches.length : 0;
    const nd = Array.isArray(a.dirs) ? a.dirs.length : 0;
    const nt = Array.isArray(a.trees) ? a.trees.length : 0;
    const parts = [];
    if (nf) parts.push(nf + ' read');
    if (ng) parts.push(ng + ' grep');
    if (nd) parts.push(nd + ' dir');
    if (nt) parts.push(nt + ' tree');
    return tick + '<span class="tc-tag">📚 Collect</span> <span class="tc-stat">' + escapeHtml(parts.join(' · ') || 'context') + '</span>';
  }
  return '';
}

function tcProposePreviewEdits(args, meta) {
  if (meta && Array.isArray(meta.previewEdits) && meta.previewEdits.length) return meta.previewEdits;
  const a = args || {};
  const op = String(a.operation || a.mode || a.action || '').toLowerCase().replaceAll(' ', '_').replaceAll('-', '_');
  if (op === 'delete_lines' || op === 'replace_lines') {
    const ranges = Array.isArray(a.ranges) && a.ranges.length ? a.ranges : (a.path ? [a] : []);
    return ranges.map((r) => ({
      path: (r && r.path) || a.path,
      startLine: r && r.startLine,
      endLine: r && r.endLine,
      newText: op === 'replace_lines' ? String((r && r.newText) == null ? (a.newText == null ? '' : a.newText) : r.newText) : '',
      __lineRangePending: true,
      __operation: op
    }));
  }
  return Array.isArray(a.edits) ? a.edits : (a.path ? [a] : []);
}

function tcBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// Build the expanded body for a finished rich tool. Returns an element, or
// null to fall back to the default <pre>.
function tcRichBody(name, args, meta, result, isError) {
  const a = args || {};
  if (isError) return null; // show the raw error in the default <pre>
  if (name === 'propose_edit') {
    const wrap = document.createElement('div');
    const edits = tcProposePreviewEdits(a, meta);
    if (!edits.length) return null;
    for (const e of edits) {
      let rows;
      if (e && e.__lineRangePending) {
        const opLabel = e.__operation === 'replace_lines' ? '按行号替换' : '按行号删除';
        rows = [{ kind: 'ctx', oldNo: null, newNo: e && e.startLine, text: opLabel + '：' + (e && e.startLine) + '-' + (e && e.endLine) + '（执行后会从磁盘补全删除内容并渲染最终 diff）' }];
        if (e.__operation === 'replace_lines' && e.newText) {
          rows = rows.concat(String(e.newText).split('\n').map((t, i) => ({ kind: 'add', oldNo: null, newNo: (e.startLine || 1) + i, text: t })));
        }
      } else {
        rows = tcLineDiff(e && e.oldText, e && e.newText, e && e.startLine);
      }
      let adds = 0, dels = 0;
      let firstChange = 0;
      for (const r of rows) {
        if (r.kind === 'add') { adds++; if (!firstChange && r.newNo) firstChange = r.newNo; }
        else if (r.kind === 'del') { dels++; if (!firstChange && r.newNo) firstChange = r.newNo; }
      }
      const jumpLine = firstChange || (e && e.startLine) || 0;
      const body = tcCodeBlock(rows, 'diff');
      // Clicking a propose_edit file opens the accept/reject diff editor and
      // jumps to the nearest change instead of just opening the file.
      wrap.appendChild(tcFileCard(e && e.path, jumpLine, '+' + adds + ' -' + dels, body, { review: true }));
    }
    return wrap;
  }
  if (name === 'write_file') {
    const content = String(a.content == null ? '' : a.content);
    const lines = content.split('\n');
    const MAX = 400;
    const shown = lines.slice(0, MAX);
    const rows = shown.map((t, i) => ({ kind: 'ctx', newNo: i + 1, text: t }));
    const body = tcCodeBlock(rows, 'plain');
    if (lines.length > MAX) {
      const more = document.createElement('div');
      more.className = 'tc-empty';
      more.textContent = '… ' + (lines.length - MAX) + ' more lines';
      body.appendChild(more);
    }
    const sz = meta && meta.bytes != null ? tcBytes(meta.bytes) : tcBytes(content.length);
    return tcFileCard(a.path, 1, sz, body);
  }
  if (name === 'read_file' || name === 'collect_context') {
    // Show the read result text with line numbers when we can infer a start.
    // The result already includes a header line we keep as-is in a <pre>-like body.
    const card = document.createElement('div');
    const text = String(result || '');
    if (name === 'read_file' && meta && meta.start != null) {
      const lines = text.split('\n');
      // Drop the tool's own "# path (lines a-b)" header line if present.
      const bodyLines = lines.length && /^#\s/.test(lines[0]) ? lines.slice(1) : lines;
      // read_file prefixes every content line with a right-padded line number
      // followed by a tab ("    1\t<code>"). The panel renders its own number in
      // the .tc-ln gutter, so strip that prefix to avoid showing it twice.
      const rows = bodyLines.map((t, i) => ({ kind: 'ctx', newNo: Number(meta.start) + i, text: String(t).replace(/^\s*\d+\t/, '') }));
      const code = tcCodeBlock(rows, 'plain');
      const metaText = (meta.end - meta.start + 1) + ' lines · ' + (meta.totalLines || '?') + ' total'
        + ((meta.hasReviewPendingEdits || meta.hasPendingEdits) ? ' · review pending (on disk)' : '');
      card.appendChild(tcFileCard(metaTextPath(meta), meta.start, metaText, code));
      return card;
    }
    // collect_context: the aggregated result text is a concatenation of
    // per-source blocks delimited by "===== <title> =====" markers (one per
    // read / grep / dir / tree). Split on those markers so each sub-result is
    // a clearly-separated card instead of one undifferentiated wall of text.
    const head = (meta && meta.tasks != null) ? (meta.tasks + ' sources') : 'context';
    const sections = tcSplitCollectSections(text);
    if (sections.length) {
      for (const sec of sections) {
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.style.maxHeight = '260px';
        pre.textContent = sec.body.slice(0, 6000);
        card.appendChild(tcFileCard(sec.title || 'context', 0, sec.meta || '', pre));
      }
      return card;
    }
    const pre = document.createElement('pre');
    pre.style.margin = '0';
    pre.style.maxHeight = '320px';
    pre.textContent = text.slice(0, 8000);
    card.appendChild(tcFileCard(name, 0, head, pre));
    return card;
  }
  return null;
}

// Split a collect_context aggregated result into its per-source sections.
// Recognises the "===== <title> =====" delimiters the tool emits. Returns
// [{ title, meta, body }]. Empty array when no markers are found (fallback).
function tcSplitCollectSections(text) {
  const src = String(text || '');
  const re = /^=====\s*(.+?)\s*=====$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(src))) {
    marks.push({ title: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  if (!marks.length) return [];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const body = src.slice(marks[i].bodyStart, end).replace(/^\n+/, '').replace(/\s+$/, '');
    // First line of a section body is often a "# count" / "# path" summary.
    let title = marks[i].title;
    let meta = '';
    const firstNl = body.indexOf('\n');
    const firstLine = firstNl >= 0 ? body.slice(0, firstNl) : body;
    if (/^#\s/.test(firstLine)) meta = firstLine.replace(/^#\s*/, '');
    out.push({ title, meta, body });
  }
  return out;
}

function metaTextPath(meta) {
  try {
    if (meta && meta.uri) {
      const u = String(meta.uri);
      return decodeURIComponent(u.replace(/^file:\/\//, ''));
    }
  } catch (_) {}
  return (meta && meta.uri) || '';
}

// Apply rich rendering to a tool <details>. Returns true if handled.
function applyRichTool(det, name, args, meta, result, isError, done) {
  const RICH = { propose_edit: 1, write_file: 1, read_file: 1, collect_context: 1 };
  if (!RICH[name]) return false;
  const sum = det.querySelector('summary');
  if (sum) {
    const html = tcSummaryHtml(name, args, meta, isError, done);
    if (html) sum.innerHTML = html;
  }
  if (done) {
    // Replace the default body with the rich body if we can build one.
    const body = tcRichBody(name, args, meta, result, isError);
    if (body) {
      // Snapshot where the live preview was scrolled BEFORE we discard it, so the
      // freshly-built body doesn't snap back to the top (the new node's scrollTop
      // is 0). Captured pre-removal; restored after the new body is in the DOM.
      const scrollSnap = captureToolScroll(det);
      // Remove any default <pre> dumps / arg streams / live previews we made earlier.
      det.querySelectorAll(':scope > pre, :scope > .tool-args-stream, :scope > .tc-stream-preview').forEach((el) => el.remove());
      det.appendChild(body);
      preserveToolScrollableAutoScroll(det, body);
      restoreToolScroll(det, scrollSnap);
    }
  }
  return true;
}

// Best-effort parse of a PARTIAL JSON args buffer streamed token-by-token.
// Closes any unterminated strings/objects/arrays so we can render a live
// preview of propose_edit / write_file before the call finishes. Returns the
// parsed object or null if even the lenient repair fails.
function tcParsePartialArgs(buf) {
  const s = String(buf || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}
  // Walk the buffer tracking string state + the stack of open containers, then
  // append the closers needed to make it valid JSON.
  let inStr = false, esc = false;
  const stack = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) { if (esc) out += '\\'; out += '"'; }
  // Drop a dangling trailing comma so closing is valid.
  out = out.replace(/,\s*$/, '');
  // Drop a dangling key-without-value at the end of an object, e.g. the buffer
  // stopped at {"summary" or {"summary": — without this the closer produces
  // {"summary"} which is invalid JSON and we'd fall back to a raw-JSON flash.
  if (stack[stack.length - 1] === '{') {
    out = out.replace(/(\{)\s*$/, '$1');                       // { with nothing after
    out = out.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, '');       // , "danglingKey"
    out = out.replace(/(\{)\s*"(?:[^"\\]|\\.)*"\s*$/, '$1');  // { "danglingKey"
    out = out.replace(/:\s*$/, ': null');                       // key: <value not yet streamed>
    out = out.replace(/,\s*$/, '');                             // re-trim after the above
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === '{' ? '}' : ']';
  }
  try { return JSON.parse(out); } catch (_) { return null; }
}

// Render a LIVE rich preview of an in-flight propose_edit / write_file while
// its args stream in. Reuses tcRichBody by treating the partial args as final.
// Returns true if a preview was rendered (so the raw JSON dump is suppressed).
function tcStreamRichPreview(det, name, partialArgs) {
  if (name !== 'propose_edit' && name !== 'write_file') return false;
  if (!partialArgs || typeof partialArgs !== 'object') return false;
  let body = tcRichBody(name, partialArgs, null, '', false);
  // Early in the stream the leading "summary" field has arrived but the
  // "edits" / "content" needed for a real diff hasn't — tcRichBody returns
  // null. Rather than fall back to dumping the raw leading JSON at the user,
  // render a lightweight placeholder so the card stays clean from the start.
  if (!body) {
    const partialBody = tcStreamPlaceholder(name, partialArgs);
    if (!partialBody) return false;
    body = partialBody;
  }
  // Swap in the freshly-built preview, dropping any prior preview / JSON dump.
  det.querySelectorAll(':scope > .tc-stream-preview, :scope > .tool-args-stream').forEach((el) => el.remove());
  body.classList.add('tc-stream-preview');
  det.appendChild(body);
  preserveStreamingPreviewAutoScroll(det, body);
  const sum = det.querySelector('summary');
  if (sum) {
    const html = tcSummaryHtml(name, partialArgs, null, false, false);
    if (html) sum.innerHTML = html;
  }
  return true;
}

// Build a minimal placeholder for an in-flight propose_edit / write_file whose
// renderable payload (edits/content) hasn't streamed in yet. Shows the summary
// text (if present) so the user never sees raw leading JSON.
function tcStreamPlaceholder(name, partialArgs) {
  const a = partialArgs || {};
  const wrap = document.createElement('div');
  const summaryText = typeof a.summary === 'string' ? a.summary : '';
  if (summaryText) {
    const sumEl = document.createElement('div');
    sumEl.className = 'tc-empty';
    sumEl.style.fontStyle = 'normal';
    sumEl.textContent = summaryText;
    wrap.appendChild(sumEl);
  }
  const hint = document.createElement('div');
  hint.className = 'tc-empty';
  hint.textContent = name === 'write_file' ? '准备写入…' : '准备编辑…';
  wrap.appendChild(hint);
  return wrap;
}

function renderMarkdown(src) {
  if (!src) return '';
  const codeBlocks = [];
  let text = String(src);
  // Fenced code blocks. Allow unterminated trailing block (during streaming).
  // Also tolerate compact one-line fences such as a json language tag followed
  // by a short JSON object and the closing fence on the same line; users often
  // paste short JSON samples that way, and CommonMark's stricter newline form
  text = text.replace(/(^|\n)([ \t]{0,3})(`{3,})([a-zA-Z0-9_+-.#]*)[ \t]+([^\n]*?)[ \t]*`{3,}(?=\n|$)/g, (m, lead, indent, fence, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return lead + '\u0000CODEBLOCK' + idx + '\u0000';
  });
  // Per CommonMark, a fence may be indented up to 3 spaces and can use 3+
  // backticks; that prefix is then stripped from every content line so XML /
  // YAML / etc. nested inside a list item don't render with phantom leading
  // whitespace before each line.
  text = text.replace(/(^|\n)([ \t]{0,3})(`{3,})([a-zA-Z0-9_+-.#]*)\n([\s\S]*?)(?:\n[ \t]{0,3}`{3,}|$)/g, (m, lead, indent, fence, lang, code) => {
    if (indent && indent.length > 0) {
      const dedent = new RegExp('^[ \t]{0,' + indent.length + '}', 'gm');
      code = code.replace(dedent, '');
    }
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return lead + '\u0000CODEBLOCK' + idx + '\u0000';
  });
  // Inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return '\u0000INLINECODE' + idx + '\u0000';
  });
  // Escape HTML now that code segments are extracted.
  text = escapeHtml(text);

  // Parse block-level structure. Recursive containers (blockquotes) call
  // renderBlocks (NOT renderMarkdown) so they SHARE the codeBlocks/inlineCodes
  // arrays extracted above. The previous code recursed via renderMarkdown,
  // which re-ran extraction on text that already contained \u0000INLINECODE
  // placeholders -- its fresh (empty) inlineCodes array then made every
  // placeholder restore to undefined, and raw.trim() later threw, truncating
  // the whole message at the first blockquote.
  let html = renderBlocks(text, codeBlocks, inlineCodes);

  // Restore inline code — detect @file-path citations and make them clickable
  html = html.replace(/\u0000INLINECODE(\d+)\u0000/g, (m, idx) => {
    const raw = inlineCodes[+idx];
    if (raw == null) return '';
    const fp = parseFilePath(raw);
    if (fp) {
      const label = escapeHtml(fileDisplayLabel(fp.path, fp.line, fp.end));
      return '<a class="file-link" href="#" data-file-path="' + escapeHtml(fp.path) + '" data-file-line="' + fp.line + '" title="' + escapeHtml(fp.path + (fp.line ? ':' + fp.line : '')) + '"><code>' + label + '</code></a>';
    }
    const sym = new RegExp('^([A-Za-z_$][A-Za-z0-9_$.]*)[(][)]$').exec(raw.trim());
    if (sym) {
      return '<a class="symbol-link" href="#" data-symbol-name="' + escapeHtml(sym[1]) + '" title="Go to: ' + escapeHtml(sym[1]) + '"><code>' + escapeHtml(raw) + '</code></a>';
    }
    return '<code>' + escapeHtml(raw) + '</code>';
  });
  // Restore fenced code blocks — detect @file-path lang to render clickable header
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, idx) => {
    const { lang, code } = codeBlocks[+idx];
    const fp = lang ? parseFilePath(lang) : null;
    if (fp) {
      const ext = fp.path.split('.').pop() || 'text';
      const langAttr = ' class="language-' + escapeHtml(ext) + '"';
      const label = escapeHtml(fileDisplayLabel(fp.path, fp.line, fp.end));
      const head = '<div class="code-head"><a class="file-link" href="#" data-file-path="' + escapeHtml(fp.path) + '" data-file-line="' + fp.line + '" title="' + escapeHtml(fp.path + (fp.line ? ':' + fp.line : '')) + '">' + label + '</a><button class="copy" type="button" title="Copy">⧉</button></div>';
      return '<pre>' + head + '<code' + langAttr + '>' + escapeHtml(code) + '</code></pre>';
    }
    const langAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    const head = '<div class="code-head"><span class="lang">' + (lang ? escapeHtml(lang) : 'text') + '</span><button class="copy" type="button" title="Copy">⧉</button></div>';
    return '<pre>' + head + '<code' + langAttr + '>' + escapeHtml(code) + '</code></pre>';
  });
  return html;
}

// Block-level parser. Operates on text whose code segments have ALREADY been
// replaced with \u0000CODEBLOCK / \u0000INLINECODE placeholders and HTML-escaped
// by renderMarkdown. codeBlocks/inlineCodes are threaded through so nested
// containers (blockquotes) can recurse here WITHOUT re-extracting placeholders.
function renderBlocks(text, codeBlocks, inlineCodes) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  const flushParagraph = (buf) => {
    if (buf.length === 0) return;
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) out.push('<p>' + applyInline(joined) + '</p>');
  };
  while (i < lines.length) {
    const line = lines[i];
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push('<h' + level + '>' + applyInline(h[2].trim()) + '</h' + level + '>');
      i++;
      continue;
    }
    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // Blockquote (consecutive). Recurse into renderBlocks with the SAME
    // placeholder arrays so inline code inside the quote resolves correctly.
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderBlocks(buf.join('\n'), codeBlocks, inlineCodes) + '</blockquote>');
      continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((t) => '<li>' + applyInline(t) + '</li>').join('') + '</ul>');
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((t) => '<li>' + applyInline(t) + '</li>').join('') + '</ol>');
      continue;
    }
    // GitHub-style table: | col | col |\n| --- | --- |
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}.*\|/.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2; // skip header + sep
      const bodyRows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      let tbl = '<table><thead><tr>' + headerCells.map((c) => '<th>' + applyInline(c) + '</th>').join('') + '</tr></thead>';
      if (bodyRows.length) {
        tbl += '<tbody>' + bodyRows.map((row) => '<tr>' + row.map((c) => '<td>' + applyInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      }
      tbl += '</table>';
      out.push(tbl);
      continue;
    }
    // Code-block placeholder line — emit as-is
    if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
      out.push(line.trim());
      i++;
      continue;
    }
    // Paragraph: gather consecutive non-blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(#{1,6})\s+/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^\s*&gt;\s?/.test(lines[i]) &&
           !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
           !/^\u0000CODEBLOCK\d+\u0000$/.test(lines[i].trim())) {
      buf.push(lines[i]);
      i++;
    }
    flushParagraph(buf);
  }
  return out.join('\n');
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseFilePath(raw) {
  const m = /^@?((?:[A-Za-z]:[\\/]|\/)[^:]*?|(?:[w.-]+[\/])+[w.-]+.[w]{1,8})(?::(\d+)(?:-(\d+))?)?$/.exec(String(raw).trim());
  if (!m) return null;
  return { path: m[1], line: m[2] ? parseInt(m[2], 10) : 0, end: m[3] ? parseInt(m[3], 10) : 0 };
}
function fileDisplayLabel(path, line, end) {
  const name = path.split(/[\\/]/).pop() || path;
  return name + (line ? ':' + line + (end ? '-' + end : '') : '');
}
function applyInline(s) {  // [label](file:path:line) — primary file link format
  s = s.replace(/\[([^\]]+)\]\(file:([^)]+)\)/g, (m, label, ref) => {
    const rm = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
    const path = rm ? rm[1] : ref;
    const line = rm && rm[2] ? parseInt(rm[2], 10) : 0;
    return '<a class="file-link" href="#" data-file-path="' + escapeHtml(path) + '" data-file-line="' + line + '" title="' + escapeHtml(path + (line ? ':' + line : '')) + '">' + escapeHtml(label) + '</a>';
  });
  // [label](sym:name) — primary symbol link format
  s = s.replace(/\[([^\]]+)\]\(sym:([^)]+)\)/g, (m, label, name) => {
    return '<a class="symbol-link" href="#" data-symbol-name="' + escapeHtml(name) + '" title="Go to: ' + escapeHtml(name) + '">' + escapeHtml(label) + '</a>';
  });
// Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // File path citations: @/abs/path.ts:line or @C:path.ts:line in plain text
  s = s.replace(/@((?:[A-Za-z]:[\\/]|\/)\S+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;!?<]|$)/g, (m, p, l1, l2) => {
    const line = l1 ? parseInt(l1, 10) : 0;
    const label = escapeHtml(fileDisplayLabel(p, line, l2 ? parseInt(l2, 10) : 0));
    return '<a class="file-link" href="#" data-file-path="' + p + '" data-file-line="' + line + '" title="' + p + (l1 ? ':' + l1 : '') + '"><code>' + label + '</code></a>';
  });
  // Bold ** or __
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic * or _ (avoid touching word_with_underscores by requiring non-word boundary)
  s = s.replace(new RegExp('(^|[^*A-Za-z0-9_])[*]([^*' + NL + ']+)[*](?=[^*A-Za-z0-9_]|$)', 'g'), '$1<em>$2</em>');
  s = s.replace(new RegExp('(^|[^_A-Za-z0-9_])_([^_' + NL + ']+)_(?=[^_A-Za-z0-9_]|$)', 'g'), '$1<em>$2</em>');
  return s;
}

function bindCodeCopy(root) {
  root.querySelectorAll('pre .copy').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const codeEl = btn.closest('pre').querySelector('code');
      const txt = codeEl ? codeEl.textContent : '';
      try {
        navigator.clipboard.writeText(txt);
        const old = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (e) { /* ignore */ }
    });
  });
}

function showEmptyState() {
  if (log.querySelector('.empty-state')) return;
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'BurstCode';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Ask anything about your codebase, or describe a change to make.';
  wrap.appendChild(title);
  wrap.appendChild(hint);
  log.appendChild(wrap);
}

function addUserMsg(text, messageIndex, checkpointRef, checkpointError, imageCount, imageUrls) {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = 'msg user';
  if (typeof messageIndex === 'number') el.dataset.messageIndex = String(messageIndex);
  if (checkpointRef) el.dataset.checkpointRef = checkpointRef;

  const gutter = document.createElement('span');
  gutter.className = 'gutter';
  gutter.textContent = '>';
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text || '';
  el.appendChild(gutter);
  if (text) el.appendChild(body);
  const urls = Array.isArray(imageUrls) ? imageUrls.filter((u) => typeof u === 'string' && u) : [];
  const count = Number(imageCount || urls.length || 0) || 0;
  if (urls.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'msg-images';
    urls.forEach((url, idx) => {
      const img = document.createElement('img');
      img.className = 'msg-image-thumb';
      img.src = url;
      img.alt = 'attached image ' + (idx + 1);
      img.title = 'Click to preview image';
      img.addEventListener('click', () => openImagePreview(url));
      grid.appendChild(img);
    });
    el.appendChild(grid);
  } else if (count > 0) {
    const imgBadge = document.createElement('span');
    imgBadge.className = 'pill';
    imgBadge.textContent = count + ' image' + (count === 1 ? '' : 's');
    imgBadge.style.marginLeft = '8px';
    el.appendChild(imgBadge);
  }

  const actions = document.createElement('div');
  actions.className = 'user-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'act copy-user-btn';
  copyBtn.title = 'Copy prompt text';
  copyBtn.setAttribute('aria-label', 'Copy prompt text');
  copyBtn.innerHTML = ICON_COPY_TEXT + '<span>Copy</span>';
  copyBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const txt = text || '';
    if (!txt) return;
    const done = () => flashCopied(copyBtn, ICON_COPY_TEXT, 'Copy');
    try {
      const p = navigator.clipboard && navigator.clipboard.writeText(txt);
      if (p && typeof p.then === 'function') p.then(done, done); else done();
    } catch (_) { done(); }
  });
  actions.appendChild(copyBtn);

  if (typeof messageIndex === 'number') {
    const currentRef = () => el.dataset.checkpointRef || '';
    const checkpointTitle = () => currentRef()
      ? 'Restore code and chat to the state right before this prompt'
      : checkpointError
        ? 'No checkpoint for this prompt (' + checkpointError + ') — only chat history can be truncated'
        : 'No checkpoint captured for this prompt — only chat history can be truncated';

    const rollbackBtn = document.createElement('button');
    rollbackBtn.type = 'button';
    rollbackBtn.className = 'act rollback-btn';
    rollbackBtn.title = checkpointTitle();
    rollbackBtn.setAttribute('aria-label', 'Rollback to before this prompt');
    if (!checkpointRef) rollbackBtn.dataset.chatOnly = 'true';
    rollbackBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4H3v3"/><path d="M3 7a5 5 0 1 0 1.5-3.5"/><path d="M8 5v4l3 1.5"/></svg><span>Rollback</span>';
    rollbackBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      rollbackBtn.title = checkpointTitle();
      vscode.postMessage({
        type: 'rollback',
        payload: { ref: currentRef(), messageIndex, prefill: true }
      });
    });
    actions.appendChild(rollbackBtn);
  }

  if (actions.childElementCount > 0) el.appendChild(actions);
  log.appendChild(el);
  // The user just submitted a prompt; jump them to the bottom regardless of
  // where they were reading, and re-arm auto-follow for the upcoming run.
  forceScrollToBottom();
  return el;
}

// SVG icons used by the assistant action bar. Hand-tuned strokes to match
// VS Code's codicon weight at 12px without pulling in another icon font.
const ICON_COPY_TEXT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="5" y="5" width="9" height="9" rx="1.5"/>'
  + '<path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>'
  + '</svg>';
const ICON_COPY_MD =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/>'
  + '<path d="M4 10V6l2 2 2-2v4M10 6v4M10 10l1.5 1.5L13 10"/>'
  + '</svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 8.5L6.5 12 13 4.5"/>'
  + '</svg>';

function flashCopied(btn, originalIconHtml, originalLabel) {
  btn.classList.add('copied');
  btn.innerHTML = ICON_CHECK + '<span>Copied</span>';
  if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
  btn._copyResetTimer = setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = originalIconHtml + '<span>' + originalLabel + '</span>';
    btn._copyResetTimer = null;
  }, 1400);
}

function buildAssistantActions(messageEl) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const mkBtn = (label, iconHtml, title, getText) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = iconHtml + '<span>' + label + '</span>';
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      const txt = getText() || '';
      if (!txt) return;
      const done = () => flashCopied(b, iconHtml, label);
      try {
        const p = navigator.clipboard && navigator.clipboard.writeText(txt);
        if (p && typeof p.then === 'function') p.then(done, done); else done();
      } catch (_) { done(); }
    });
    return b;
  };

  const textBtn = mkBtn('Copy text', ICON_COPY_TEXT, 'Copy rendered text',
    () => { const m = messageEl.querySelector('.md'); return m ? m.innerText : ''; });
  const mdBtn = mkBtn('Copy Markdown', ICON_COPY_MD, 'Copy Markdown source',
    () => messageEl.dataset.raw || '');

  bar.appendChild(textBtn);
  const sep = document.createElement('span');
  sep.className = 'sep';
  bar.appendChild(sep);
  bar.appendChild(mdBtn);
  return bar;
}

function addAssistantMsg(text) {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const md = document.createElement('div');
  md.className = 'md';
  el.appendChild(md);
  el.dataset.raw = text || '';
  md.innerHTML = renderMarkdown(text || '');
  bindCodeCopy(md);
  el.appendChild(buildAssistantActions(el));
  log.appendChild(el);
  scrollToBottom();
  return el;
}

function addReasoningMsg(text, opts) {
  clearEmptyState();
  const det = document.createElement('details');
  det.className = 'reasoning';
  // Open by default while streaming so the user sees progress; closed when
  // restoring from a saved transcript.
  det.open = !!(opts && opts.open);
  const sum = document.createElement('summary');
  if (opts && opts.streaming) sum.dataset.streaming = 'true';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Thinking';
  sum.appendChild(label);
  det.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text || '';
  det.appendChild(body);
  det.dataset.raw = text || '';
  log.appendChild(det);
  scrollToBottom();
  return det;
}

function addErrorMsg(text) {
  clearEmptyState();
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = text;
  log.appendChild(el);
  scrollToBottom();
  return el;
}

function updateSendButton() {
  if (!busy) {
    sendBtn.dataset.mode = 'send';
    sendBtn.title = 'Send (Enter)';
    sendBtn.setAttribute('aria-label', 'Send');
  } else {
    // Keep the primary action as Stop while a run is in progress. Queueing has
    // its own dedicated button, so typing in the composer must not turn Stop
    // back into Send/Queue.
    sendBtn.dataset.mode = 'stop';
    sendBtn.title = 'Stop (Esc)';
    sendBtn.setAttribute('aria-label', 'Stop');
  }
}

function updateQueueButton() {
  queueBtn.classList.toggle('show', busy && input.value.trim().length > 0);
}

function setBusy(v) {
  busy = v;
  updateSendButton();
  updateQueueButton();
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
	    case 'start-user-activity-listener':
	      startTaskDoneUserActivityListener(
	        msg.payload && msg.payload.events,
	        !(msg.payload && msg.payload.focused === false)
	      );
	      break;
	    case 'stop-user-activity-listener':
	      stopTaskDoneUserActivityListener();
	      break;
	    case 'window-focus-state':
	      taskDoneUserActivityWindowFocused = !!(msg.payload && msg.payload.focused);
	      break;
	    case 'start-client-alert-sound':
	      startClientAlertSound(
	        msg.payload && msg.payload.kind,
	        msg.payload && msg.payload.intervalMs
	      );
	      break;
	    case 'stop-client-alert-sound':
	      stopClientAlertSound(msg.payload && msg.payload.kind);
	      break;
	    case 'show-client-attention-notification':
	      showClientAttentionNotification(msg.payload && msg.payload.message);
	      break;
    case 'rollback-start':
      rollbackOverlay.classList.add('active');
      break;
    case 'rollback-end':
      rollbackOverlay.classList.remove('active');
      break;
    case 'reset':
      rollbackOverlay.classList.remove('active');
      log.innerHTML = '';
      activeAssistantEl = null;
      activeReasoningEl = null;
      activeStreamingToolEl = null;
      toolElements.clear();
      runningTools.clear();
      currentIter = 0;
      renderPlan([]);
      // Reset the send button back to send mode. Other sessions may still be
      // running in the background, but THIS view (the fresh / new-chat view)
      // has no in-flight run, so the composer must accept input again.
      // Without this, clicking "+" while session A is running leaves the
      // button stuck in Stop mode and blocks new prompts.
      setBusy(false);
      setStatus('idle', 'Idle');
      showEmptyState();
      break;
    case 'load-session': {
      renderTranscript(msg.payload.transcript || []);
      renderPlan(msg.payload.plan || []);
      runningTools.clear();
      currentIter = 0;
      const loadedStatus = String((msg.payload && msg.payload.status) || 'idle');
      if (loadedStatus === 'running') {
        // Don't go idle — a live-state-replay event will follow with the
        // accurate snapshot. Show a neutral placeholder until then.
        setBusy(true);
        setStatus('busy', 'Resuming...');
      } else {
        setBusy(false);
        const map = { completed: ['done', 'Done'], stopped: ['error', 'Stopped'], error: ['error', 'Error'], idle: ['idle', 'Idle'] };
        const [st, lb] = map[loadedStatus] || ['idle', 'Idle'];
        setStatus(st, lb);
      }
      break;
    }
    case 'live-state-replay': {
      // Switched back into a session that is still running. The transcript
      // (already replayed by load-session) reflects everything FINALIZED so
      // far; this snapshot fills in the in-flight bits: iter pills, partial
      // assistant/reasoning bubbles, and any tool calls still mid-flight.
      replayLiveState(msg.payload || {});
      break;
    }
    case 'prefill-composer': {
      // Sent after a rollback so the user can edit-and-resend the prompt
      // that just got truncated, instead of retyping it from scratch.
      const t = (msg.payload && typeof msg.payload.text === 'string') ? msg.payload.text : '';
      input.value = t;
      autosizeInput();
      input.focus();
      // Drop the caret at the end so the user can keep typing immediately.
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch { /* not focused yet */ }
      break;
    }
    case 'plan-update':
      renderPlan(msg.payload.steps || []);
      break;
    case 'sessions':
      sessionsCache = msg.payload || { sessions: [], activeId: null, openIds: [] };
      // Defensive: older backends may not send openIds; fall back to empty.
      if (!Array.isArray(sessionsCache.openIds)) sessionsCache.openIds = [];
      // Tabs strip is always visible (when non-empty) so it must re-render
      // on every broadcast — status badges, active highlight, ordering all
      // depend on the latest payload.
      renderTabs();
      if (historyEl.classList.contains('open')) renderHistory();
      break;
    case 'lessons': {
      const list = (msg.payload && Array.isArray(msg.payload.lessons)) ? msg.payload.lessons : [];
      lessonsCache = list;
      // Keep the badge dot in sync with the count for visual feedback.
      lessonsBtn.title = list.length
        ? 'Lessons (' + list.length + ' recorded)'
        : 'Lessons (recorded user corrections)';
      if (lessonsEl.classList.contains('open')) renderLessons();
      break;
    }
    case 'user-message':
      addUserMsg(
        msg.payload.text,
        msg.payload.messageIndex,
        msg.payload.checkpointRef,
        msg.payload.checkpointError,
        msg.payload.imageCount,
        msg.payload.imageUrls
      );
      break;
    case 'queued-user-message': {
      // User sent a message while the agent was running. Display it with a
      // "queued" badge; the AgentLoop will inject it at the next iteration.
      clearEmptyState();
      const qEl = document.createElement('div');
      qEl.className = 'msg user queued';
      const qId = msg.payload && msg.payload.id ? String(msg.payload.id) : '';
      if (qId) qEl.dataset.queuedId = qId;
      const qGutter = document.createElement('span');
      qGutter.className = 'gutter';
      qGutter.textContent = '>';
      const qBody = document.createElement('span');
      qBody.className = 'body';
      qBody.textContent = msg.payload.text || '';
      const qBadge = document.createElement('span');
      qBadge.className = 'queued-badge';
      qBadge.textContent = 'queued';
      const qUndo = document.createElement('button');
      qUndo.className = 'queued-undo';
      qUndo.type = 'button';
      qUndo.textContent = 'Undo';
      qUndo.title = 'Remove this queued message before it is sent to the LLM';
      qUndo.addEventListener('click', () => {
        if (!qId) return;
        qUndo.disabled = true;
        qUndo.textContent = 'Undoing…';
        vscode.postMessage({ type: 'undo-queued-user-message', payload: { id: qId } });
      });
      qEl.appendChild(qGutter);
      qEl.appendChild(qBody);
      qEl.appendChild(qBadge);
      qEl.appendChild(qUndo);
      log.appendChild(qEl);
      scrollToBottom();
      break;
    }
    case 'queued-user-message-undone': {
      const id = msg.payload && msg.payload.id ? String(msg.payload.id) : '';
      if (!id) break;
      const qEl = log.querySelector('[data-queued-id="' + cssAttrEscape(id) + '"]');
      if (!qEl) break;
      if (msg.payload && msg.payload.removed) {
        const restoredText = (typeof msg.payload.text === 'string') ? msg.payload.text : '';
        qEl.remove();
        if (restoredText) {
          const current = input.value || '';
          input.value = current.trim().length > 0 ? current + String.fromCharCode(10) + restoredText : restoredText;
          autosizeInput();
          updateQueueButton();
          input.focus();
          const len = input.value.length;
          try { input.setSelectionRange(len, len); } catch (_) { /* not focused yet */ }
        }
      } else {
        const btn = qEl.querySelector('.queued-undo');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Sent';
          btn.title = 'This queued message has already been sent to the LLM';
        }
      }
      break;
    }
    case 'update-checkpoint-ref': {
      // Checkpoint was created asynchronously after the user message was
      // rendered. Update the rollback button so clicking it sends the real ref.
      const cpIdx = msg.payload.messageIndex;
      const cpRef = msg.payload.ref;
      if (cpRef) {
        const msgEl = log.querySelector('[data-message-index="' + cpIdx + '"]');
        if (msgEl) {
          msgEl.dataset.checkpointRef = cpRef;
          const rollbackBtn = msgEl.querySelector('.rollback-btn');
          if (rollbackBtn) {
            rollbackBtn.title = 'Restore code and chat to the state right before this prompt';
            delete rollbackBtn.dataset.chatOnly;
          }
          const retryBtn = msgEl.querySelector('.retry-user-btn');
          if (retryBtn) {
            retryBtn.title = 'Retry from the state right before this prompt';
            delete retryBtn.dataset.chatOnly;
          }
        }
      }
      break;
    }
    case 'run-start': {
      activeAssistantEl = null;
      activeReasoningEl = null;
      activeStreamingToolEl = null;
      runningTools.clear();
      currentIter = 0;
      runStartedAt = 0;
      setBusy(true);
      setStatus('busy', 'Thinking...');
      break;
    }
    case 'iteration': {
      clearEmptyState();
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      pill.innerHTML = '<span class="pill">iter ' + (msg.payload.iter + 1) + '</span>';
      log.appendChild(pill);
      scrollToBottom();
      activeAssistantEl = null;
      activeReasoningEl = null;
      currentIter = msg.payload.iter + 1;
      setStatus('busy', 'Thinking (iter ' + currentIter + ')...');
      break;
    }
    case 'auto-continue': {
      clearEmptyState();
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      pill.innerHTML = '<span class="pill">↻ auto-continue ' + msg.payload.count + '/' + msg.payload.max + '</span>';
      log.appendChild(pill);
      scrollToBottom();
      activeAssistantEl = null;
      activeReasoningEl = null;
      setStatus('continue', 'Auto-continuing ' + msg.payload.count + '/' + msg.payload.max + '...');
      break;
    }
      case 'auto-resume': {
        // Stream was interrupted mid-turn. When backend auto-resume can seed the
        // next attempt with the partial tool args already received, keep the live
        // tool preview and routing IDs intact so suffix deltas append to the same
        // card. This matches the execution model: code prepends the in-memory
        // prefix before parsing the final tool call; the UI should also display
        // one continuing preview, not an interrupted duplicate plus a restarted one.
        clearEmptyState();
        activeAssistantEl = null;
        activeReasoningEl = null;
        for (const [, det] of Array.from(toolElements.entries())) {
          if (det.dataset.running === 'true') {
            det.dataset.resuming = 'true';
            det.open = true;
            const s = det.querySelector('summary');
            const name = det.dataset.toolName || '?';
            if (s) s.textContent = '⟳ ' + name + ' · stream interrupted, resuming...';
          }
        }
        const attempt = (msg.payload && msg.payload.attempt) || 1;
        const max = (msg.payload && msg.payload.max) || 1;
        const errText = (msg.payload && msg.payload.error) ? String(msg.payload.error) : 'stream interrupted';
        const pill = document.createElement('div');
        pill.className = 'iter-pill';
        pill.innerHTML = '<span class="pill" title="' + escapeHtml(errText) + '">↻ auto-resume ' + attempt + '/' + max + '</span>';
        log.appendChild(pill);
        scrollToBottom();
        setStatus('continue', 'Stream interrupted, resuming ' + attempt + '/' + max + '...');
        break;
      }
    case 'reasoning-delta': {
      const delta = String(msg.payload && msg.payload.text || '');
      if (!activeReasoningEl && delta.trim().length === 0) break;
      if (!activeReasoningEl) {
        activeReasoningEl = addReasoningMsg('', { open: true, streaming: true });
      }
      const raw = (activeReasoningEl.dataset.raw || '') + delta;
      activeReasoningEl.dataset.raw = raw;
      const body = activeReasoningEl.querySelector('.body');
      if (body) body.textContent = raw;
      scrollToBottom();
      break;
    }
    case 'assistant-delta': {
      // First content delta after thinking arrived: stop the pulse and
      // collapse the thinking block so the answer takes focus.
      if (activeReasoningEl) {
        const rawReasoning = activeReasoningEl.dataset.raw || '';
        if (rawReasoning.trim().length === 0) {
          activeReasoningEl.remove();
        } else {
          const sum = activeReasoningEl.querySelector('summary');
          if (sum) delete sum.dataset.streaming;
          activeReasoningEl.open = false;
        }
        activeReasoningEl = null;
      }
      if (!activeAssistantEl) {
        activeAssistantEl = addAssistantMsg('');
        if (runningTools.size === 0) {
          setStatus('busy', currentIter ? 'Streaming (iter ' + currentIter + ')...' : 'Streaming...');
        }
      }
      activeAssistantEl.dataset.raw = (activeAssistantEl.dataset.raw || '') + msg.payload.text;
      scheduleRender(activeAssistantEl);
      break;
    }
    case 'assistant-message':
      // End-of-turn: also stop reasoning pulse if the model emitted no
      // assistant content (tool-only turns).
      if (activeReasoningEl) {
        const rawReasoning = activeReasoningEl.dataset.raw || '';
        if (rawReasoning.trim().length === 0) {
          activeReasoningEl.remove();
        } else {
          const sum = activeReasoningEl.querySelector('summary');
          if (sum) delete sum.dataset.streaming;
          activeReasoningEl.open = false;
        }
        activeReasoningEl = null;
      }
      if (activeAssistantEl && msg.payload && typeof msg.payload.text === 'string') {
        const finalText = msg.payload.text;
        if (finalText.trim().length === 0) {
          activeAssistantEl.remove();
        } else {
          activeAssistantEl.dataset.raw = finalText;
          const mdEl = activeAssistantEl.querySelector('.md');
          if (mdEl) {
            mdEl.innerHTML = renderMarkdown(finalText);
            bindCodeCopy(mdEl);
          }
        }
      }
      activeAssistantEl = null;
      scrollToBottom();
      break;
    case 'tool-call-start': {
      clearEmptyState();
      const existingKey = msg.payload.id || msg.payload.name + Date.now();
      console.log('[Webview] tool-call-start received. name=' + msg.payload.name + ', id=' + msg.payload.id + ', existingKey=' + existingKey + ', existsInToolElements=' + toolElements.has(existingKey) + ', args=' + JSON.stringify(msg.payload.args));
      if (toolElements.has(existingKey)) {
        const existingDet = toolElements.get(existingKey);
        const existingSum = existingDet.querySelector('summary');
        if (msg.payload.streaming) {
          existingDet.dataset.running = 'true';
          existingDet.dataset.streaming = 'true';
          delete existingDet.dataset.resuming;
          activeStreamingToolEl = existingDet;
          if (existingSum) existingSum.textContent = '🔧 ' + msg.payload.name + '(continuing streamed args...) · running...';
          break;
        }
        if (!applyRichTool(existingDet, msg.payload.name, msg.payload.args, msg.payload.meta, null, false, false)) {
          if (existingSum) existingSum.textContent = '🔧 ' + msg.payload.name + '(' + JSON.stringify(msg.payload.args).slice(0, 200) + ') · running...';
        }
        delete existingDet.dataset.streaming;
        activeStreamingToolEl = null;
        break;
      }
      const det = document.createElement('details');
      det.className = 'tool';
      det.dataset.running = 'true';
      det.dataset.toolName = String(msg.payload.name || '');
      try { det._tcArgs = msg.payload.args; } catch (e) {}
      if (msg.payload.streaming) {
        det.dataset.streaming = 'true';
        activeStreamingToolEl = det;
        det.open = true;
      } else {
        det.open = false;
      }
      const sum = document.createElement('summary');
      sum.textContent = '🔧 ' + msg.payload.name + '(' + JSON.stringify(msg.payload.args).slice(0, 200) + ') · running...';
      det.appendChild(sum);
      log.appendChild(det);
      applyRichTool(det, msg.payload.name, msg.payload.args, msg.payload.meta, null, false, false);
      const key = existingKey;
      toolElements.set(key, det);
      runningTools.set(key, { name: msg.payload.name, startedAt: Date.now() });
      const names = Array.from(runningTools.values()).map((t) => t.name).join(', ');
      setStatus('tool', 'Running ' + names + '...');
      scrollToBottom();
      break;
    }
    case 'tool-call-args-delta': {
      const argKey = msg.payload && msg.payload.id;
      // Prefer id-based lookup; fall back to the currently-streaming element.
      // Some models omit id from streaming deltas, so we can't rely on it.
      const argDet = (argKey && toolElements.get(argKey)) || activeStreamingToolEl;
      if (argDet) {
        argDet.dataset.argsBuf = (argDet.dataset.argsBuf || '') + msg.payload.delta;
        const buf = argDet.dataset.argsBuf;
        if (buf.length > 16000) argDet.dataset.argsBuf = buf.slice(0, 16000);
        // For propose_edit / write_file, render a LIVE diff/code preview from
        // the partial args instead of dumping raw JSON tokens at the user.
        const tn = argDet.dataset.toolName || '';
        let rendered = false;
        const isRichTool = (tn === 'propose_edit' || tn === 'write_file');
        if (isRichTool) {
          const partial = tcParsePartialArgs(argDet.dataset.argsBuf);
          if (partial) rendered = tcStreamRichPreview(argDet, tn, partial);
        }
        if (!rendered) {
          // For propose_edit / write_file, NEVER dump the raw, unclosed JSON
          // buffer at the user: a single frame whose partial JSON fails to
          // repair would flash half-open JSON (e.g. {"summary": "…). Instead
          // keep whatever rich preview / placeholder the previous frame already
          // rendered. The final, complete render happens on tool-call-end.
          // Only non-rich tools fall back to showing the streaming arg text.
          if (isRichTool) {
            // Seed an initial placeholder once, so the very first frames (before
            // any field is parseable) still look clean rather than empty.
            if (!argDet.querySelector('.tc-stream-preview')) {
              const ph = tcStreamPlaceholder(tn, {});
              if (ph) {
                argDet.querySelectorAll(':scope > .tool-args-stream').forEach((el) => el.remove());
                ph.classList.add('tc-stream-preview');
                argDet.appendChild(ph);
              }
            }
          } else {
            let argPre = argDet.querySelector('.tool-args-stream');
            if (!argPre) {
              argPre = document.createElement('pre');
              argPre.className = 'tool-args-stream';
              argDet.appendChild(argPre);
            }
            const shown = argDet.dataset.argsBuf;
            argPre.textContent = shown.length > 8000 ? '...' + shown.slice(-7000) : shown;
            preserveToolScrollableAutoScroll(argDet, argPre);
          }
        }
        scrollToBottom();
      }
      break;
    }
    case 'tool-progress': {
      const progKey = msg.payload && msg.payload.id;
      let progDet = progKey ? toolElements.get(progKey) : null;
      if (!progDet) {
        const items = Array.from(toolElements.values());
        progDet = items[items.length - 1] || null;
      }
      if (progDet) {
        let progPre = progDet.querySelector('.tool-progress-log');
        if (!progPre) {
          progPre = document.createElement('pre');
          progPre.className = 'tool-progress-log';
          progDet.appendChild(progPre);
          progDet.open = true;
        }
        const line = String((msg.payload && msg.payload.message) || '');
        progPre.textContent = (progPre.textContent ? progPre.textContent + '\n' : '') + line;
          if (progPre.textContent.length > 8000) {
            progPre.textContent = '...' + progPre.textContent.slice(-7500);
          }
          preserveToolScrollableAutoScroll(progDet, progPre);
      }
      scrollToBottom();
      break;
    }
    case 'tool-call-end': {
      const key = msg.payload.id;
      let det = key ? toolElements.get(key) : null;
      if (!det) {
        const items = Array.from(toolElements.values());
        det = items[items.length - 1];
      }
      if (det) {
        det.dataset.error = String(!!msg.payload.isError);
        det.dataset.running = 'false';
        // Prefer the authoritative, fully-parsed args delivered with tool-call-end.
        // _tcArgs only holds the args known at tool-call-start time, which for a
        // streamed call is {} — relying on it would freeze the preview on the last
        // partial stream frame and drop the final tokens. Fall back to _tcArgs only
        // when the end payload carries no args.
        const hasEndArgs = msg.payload.args != null
          && typeof msg.payload.args === 'object'
          && Object.keys(msg.payload.args).length > 0;
        const endArgs = hasEndArgs ? msg.payload.args : (det._tcArgs != null ? det._tcArgs : msg.payload.args);
        const handled = applyRichTool(
          det,
          msg.payload.name,
          endArgs,
          msg.payload.meta,
          msg.payload.result,
          !!msg.payload.isError,
          true
        );
        if (!handled) {
          const sum = det.querySelector('summary');
          sum.textContent = (msg.payload.isError ? '⚠ ' : '✓ ') + msg.payload.name + ' · done';
          const pre = document.createElement('pre');
          pre.textContent = (msg.payload.result || '').slice(0, 4000);
          det.appendChild(pre);
          preserveToolScrollableAutoScroll(det, pre);
        }
      }
      if (key) runningTools.delete(key);
      if (runningTools.size === 0) {
        setStatus('busy', currentIter ? 'Thinking (iter ' + currentIter + ')...' : 'Thinking...');
      } else {
        const names = Array.from(runningTools.values()).map((t) => t.name).join(', ');
        setStatus('tool', 'Running ' + names + '...');
      }
      scrollToBottom();
      break;
    }
    case 'pending-edits': {
      const p = msg.payload || { files: 0, hunks: 0 };
      renderPendingBanner(p);
      if (p.recentDecision) {
        // Show a brief inline note in the chat log so the user can see the
        // outcome scrolling alongside the conversation.
        clearEmptyState();
        const flash = document.createElement('div');
        const wasAccepted = /accepted/.test(p.recentDecision) && !/all hunks rejected/.test(p.recentDecision);
        flash.className = 'decision-flash ' + (wasAccepted ? 'accept' : 'reject');
        flash.textContent = (wasAccepted ? '✓ ' : '✕ ') + p.recentDecision;
        log.appendChild(flash);
        scrollToBottom();
      }
      break;
    }
    case 'action-error': {
      const p = msg.payload || {};
      if (String(p.action || '').indexOf('edits') >= 0) {
        pendingAcceptBtn.disabled = false;
        pendingRejectBtn.disabled = false;
      }
      addErrorMsg('⚠ ' + (p.message || 'Action failed'));
      break;
    }
    case 'ask-user': {
      const payload = msg.payload || {};
      const askId = String(payload.id || '');
      const inputType = payload.inputType === 'multi' || payload.inputType === 'text' ? payload.inputType : 'single';
      const rawOptions = Array.isArray(payload.options) ? payload.options : [];
      const allowCustomText = !!payload.allowCustomText || inputType === 'text';
      const placeholder = String(payload.placeholder || '');

      const wrap = document.createElement('div');
      wrap.className = 'ask ask-clarify';
      wrap.dataset.askId = askId;

      // Header tag: clarifies which input mode the user is dealing with.
      const header = document.createElement('div');
      header.className = 'ask-header';
      const tag = document.createElement('span');
      tag.className = 'ask-mode';
      tag.textContent =
        inputType === 'multi' ? 'Pick any' : inputType === 'text' ? 'Free text' : 'Pick one';
      header.appendChild(tag);
      const q = document.createElement('div');
      q.className = 'ask-question';
      q.textContent = '❓ ' + String(payload.question || '');
      header.appendChild(q);
      wrap.appendChild(header);

      // Map normalized {label, description} entries to the controls.
      const options = rawOptions.map((o) => {
        if (typeof o === 'string') return { label: o, description: '' };
        return { label: String(o && o.label || ''), description: String(o && o.description || '') };
      }).filter((o) => o.label);

      let textInput = null;
      const sendAnswer = (answer) => {
        if (wrap.dataset.done === '1') return;
        wrap.dataset.done = '1';
        // Replace the entire question/options box with a compact user-reply-style
        // line that only shows the selected option(s). The framing of the box is
        // dropped via the "collapsed" modifier so it blends into the chat flow.
        wrap.classList.add('answered', 'collapsed');
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const reply = document.createElement('div');
        reply.className = 'ask-reply';
        const gutter = document.createElement('span');
        gutter.className = 'gutter';
        gutter.textContent = '>';
        const body = document.createElement('span');
        body.className = 'body';
        body.textContent = answer || '(empty)';
        reply.appendChild(gutter);
        reply.appendChild(body);
        wrap.appendChild(reply);
        vscode.postMessage({ type: 'ask-user-response', payload: { id: askId, answer: answer, sessionId: sessionsCache.activeId || null } });
      };

      if (inputType === 'single') {
        const list = document.createElement('div');
        list.className = 'ask-choices';
        options.forEach((o) => {
          const btn = document.createElement('button');
          btn.className = 'secondary ask-choice';
          const lbl = document.createElement('div');
          lbl.className = 'ask-choice-label';
          lbl.textContent = o.label;
          btn.appendChild(lbl);
          if (o.description) {
            const desc = document.createElement('div');
            desc.className = 'ask-choice-desc';
            desc.textContent = o.description;
            btn.appendChild(desc);
          }
          btn.onclick = () => sendAnswer(o.label);
          list.appendChild(btn);
        });
        wrap.appendChild(list);
      } else if (inputType === 'multi') {
        const list = document.createElement('div');
        list.className = 'ask-choices ask-choices-multi';
        const checks = [];
        options.forEach((o, i) => {
          const row = document.createElement('label');
          row.className = 'ask-check-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = o.label;
          cb.id = (askId || 'ask') + '_opt_' + i;
          checks.push(cb);
          row.appendChild(cb);
          const txt = document.createElement('div');
          txt.className = 'ask-check-text';
          const lbl = document.createElement('div');
          lbl.className = 'ask-choice-label';
          lbl.textContent = o.label;
          txt.appendChild(lbl);
          if (o.description) {
            const desc = document.createElement('div');
            desc.className = 'ask-choice-desc';
            desc.textContent = o.description;
            txt.appendChild(desc);
          }
          row.appendChild(txt);
          list.appendChild(row);
        });
        wrap.appendChild(list);

        if (allowCustomText) {
          textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.className = 'ask-text';
          textInput.placeholder = placeholder || 'Optional: add a custom note…';
          wrap.appendChild(textInput);
        }

        const actions = document.createElement('div');
        actions.className = 'options';
        const submit = document.createElement('button');
        submit.textContent = 'Submit';
        submit.onclick = () => {
          const picked = checks.filter((c) => c.checked).map((c) => c.value);
          let answer = picked.join(', ');
          if (textInput && textInput.value.trim()) {
            answer = answer ? answer + ' | ' + textInput.value.trim() : textInput.value.trim();
          }
          sendAnswer(answer);
        };
        actions.appendChild(submit);
        wrap.appendChild(actions);
      } else {
        // text-only
        textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'ask-text';
        textInput.placeholder = placeholder || 'Type your answer…';
        wrap.appendChild(textInput);
        const actions = document.createElement('div');
        actions.className = 'options';
        const submit = document.createElement('button');
        submit.textContent = 'Submit';
        submit.onclick = () => sendAnswer(textInput.value);
        actions.appendChild(submit);
        wrap.appendChild(actions);
        textInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            sendAnswer(textInput.value);
          }
        });
      }

      // For single+allowCustomText, also offer a text fallback alongside buttons.
      if (inputType === 'single' && allowCustomText) {
        textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'ask-text';
        textInput.placeholder = placeholder || 'Or type a custom answer…';
        wrap.appendChild(textInput);
        const actions = document.createElement('div');
        actions.className = 'options';
        const submit = document.createElement('button');
        submit.textContent = 'Submit text';
        submit.onclick = () => {
          const v = textInput.value.trim();
          if (v) sendAnswer(v);
        };
        actions.appendChild(submit);
        wrap.appendChild(actions);
        textInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            const v = textInput.value.trim();
            if (v) sendAnswer(v);
          }
        });
      }

      log.appendChild(wrap);
      if (textInput) textInput.focus();
      // Asking the user a question requires their attention; pull the panel
      // back to the bottom even if they had scrolled up.
      forceScrollToBottom();
      break;
    }
    case 'ask-user-cancel': {
      // Run was cancelled while a question was open; lock the inputs so the
      // user understands their answer is no longer needed.
      const id = String((msg.payload && msg.payload.id) || '');
      const node = id ? log.querySelector('.ask-clarify[data-ask-id="' + id + '"]') : null;
      if (node && node.dataset.done !== '1') {
        node.dataset.done = '1';
        node.classList.add('answered', 'cancelled');
        const ctrls = node.querySelectorAll('button, input, label');
        ctrls.forEach((el) => { el.setAttribute('disabled', 'true'); el.classList.add('disabled'); });
        const note = document.createElement('div');
        note.className = 'ask-answer';
        note.textContent = '↪ (cancelled — no answer sent)';
        node.appendChild(note);
      }
      break;
    }
    case 'error':
      addErrorMsg('⚠ ' + (typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload)));
      setBusy(false);
      for (const key of Array.from(runningTools.keys())) {
        const det = toolElements.get(key);
        if (det && det.dataset.running === 'true') {
          det.dataset.running = 'false';
          const s = det.querySelector('summary');
          if (s) s.textContent = '⚠ ' + (runningTools.get(key)?.name || '?') + ' · cancelled';
        }
      }
      activeStreamingToolEl = null;
      runningTools.clear();
      setStatus('error', 'Error');
      break;
    case 'done': {
      setBusy(false);
      const reason = (msg.payload && msg.payload.reason) || 'stop';
      const labels = {
        stop: 'Done',
        tool_calls: 'Done',
        proposed_edit_done: 'Done · edit proposed',
        cancelled: 'Cancelled',
        max_iterations: 'Stopped: max iterations reached',
        length: 'Stopped: output truncated',
        stuck: 'Stopped: agent appeared stuck (no askUser)',
        'aborted-stuck': 'Stopped: aborted after repeated tool-calls'
      };
      const errorish = reason === 'cancelled' || reason === 'max_iterations' || reason === 'stuck' || reason === 'aborted-stuck';
      // Cancel any leftover pre-announced tool elements that never ran.
      for (const key of Array.from(runningTools.keys())) {
        const det = toolElements.get(key);
        if (det && det.dataset.streaming === 'true') {
          det.dataset.running = 'false';
          delete det.dataset.streaming;
          const s = det.querySelector('summary');
          if (s) s.textContent = '⚠ ' + (runningTools.get(key)?.name || '?') + ' · cancelled';
          toolElements.delete(key);
        }
      }
      runningTools.clear();
      setStatus(errorish ? 'error' : 'done', labels[reason] || ('Done (' + reason + ')'));
      break;
    }
    case 'models': {
      const payload = msg.payload || { chat: { baseURL: '', model: '', models: [] }, active: { model: '' }, fetched: null, video: { resolution: '1280x720' } };
      const newChat = payload.chat || { baseURL: '', model: '', models: [] };
      const oldBaseURL = modelsState.chat.baseURL;
      modelsState.chat = newChat;
      modelsState.active = payload.active || { model: modelsState.chat.model || '' };
      modelsState.video = payload.video || modelsState.video || { resolution: '1280x720' };
      const cached = payload.fetched && Array.isArray(payload.fetched.models) ? payload.fetched : null;
      if (oldBaseURL !== newChat.baseURL) {
        // baseURL changed — discard any in-flight state and seed from the
        // cache shipped by the host (or wipe if there is none).
        modelsState.fetched = {
          loading: false,
          models: cached ? cached.models.slice() : null,
          error: null,
          fetchedAt: cached ? cached.fetchedAt : 0
        };
      } else if (cached && !modelsState.fetched.loading) {
        // Same baseURL, no refresh in flight: refresh from the cache so
        // newly-persisted entries show up without losing user state.
        modelsState.fetched.models = cached.models.slice();
        modelsState.fetched.fetchedAt = cached.fetchedAt;
      }
      renderModelPickerLabel();
      if (modelPicker.classList.contains('open')) { renderModelPicker(); positionModelPicker(); }
      break;
    }
    case 'models-fetched': {
      const { models, error, fetchedAt } = msg.payload || {};
      modelsState.fetched = {
        loading: false,
        models: Array.isArray(models) ? models : (modelsState.fetched && modelsState.fetched.models) || null,
        error: error || null,
        fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : (modelsState.fetched && modelsState.fetched.fetchedAt) || 0
      };
      if (modelPicker.classList.contains('open')) { renderModelPicker(); positionModelPicker(); }
      break;
    }
    case 'context-usage': {
      const p = msg.payload || { used: 0, max: 0 };
      setContextUsage(p.used, p.max);
      break;
    }
    case 'bg-status': {
      setBgStatus(msg.payload);
      break;
    }
    case 'context-compressed': {
      const p = msg.payload || { before: 0, after: 0, max: 0 };
      setContextUsage(p.after, p.max);
      // Brief flash + inline note so users notice the auto-compression.
      ctxUsageEl.classList.remove('flash');
      // Force reflow to restart the animation.
      void ctxUsageEl.offsetWidth;
      ctxUsageEl.classList.add('flash');
      const note = document.createElement('div');
      note.className = 'decision-flash';
      note.style.opacity = '0.7';
      note.textContent = '↯ Context auto-compressed: ' + fmtTokens(p.before)
        + ' → ' + fmtTokens(p.after) + ' tokens';
      log.appendChild(note);
      scrollToBottom();
      break;
    }
    case 'stuck-detected': {
      const p = msg.payload || { repeats: 0, calls: '', action: '' };
      const note = document.createElement('div');
      note.className = 'decision-flash reject';
      const verb = p.action === 'ask-user'
        ? 'asking you to weigh in'
        : 'nudging the model to try a different approach';
      note.textContent = '⚠ Detected ' + p.repeats + ' identical tool-call turns ('
        + (p.calls || 'unknown') + ') — ' + verb + '.';
      log.appendChild(note);
      scrollToBottom();
      break;
    }
  }
});

	function autosizeInput() {
	  input.style.height = 'auto';
	  const max = 220;
	  const next = Math.min(input.scrollHeight, max);
	  input.style.height = next + 'px';
	  input.classList.toggle('scroll', input.scrollHeight > max + 1);
	}
	
	input.addEventListener('input', autosizeInput);
	autosizeInput();
	
	let pastedImages = [];
	let currentModelSupportsVision = false;
		function updateInputPlaceholder() {
		  input.placeholder = pastedImages.length > 0 ? 'Add a message (optional)...' : 'Ask BurstCode...';
		}
	let imagePreviewScale = 1;
	let imagePreviewX = 0;
	let imagePreviewY = 0;
	let imagePreviewDrag = null;
	function applyImagePreviewTransform() {
	  imagePreviewImg.style.transform = 'translate(' + imagePreviewX + 'px, ' + imagePreviewY + 'px) scale(' + imagePreviewScale + ')';
	}
	function resetImagePreviewTransform() {
	  imagePreviewScale = 1;
	  imagePreviewX = 0;
	  imagePreviewY = 0;
	  imagePreviewDrag = null;
	  imagePreviewStage.classList.remove('dragging');
	  applyImagePreviewTransform();
	}
	function zoomImagePreview(delta, originX, originY) {
	  const oldScale = imagePreviewScale;
	  const nextScale = Math.max(0.2, Math.min(8, imagePreviewScale * delta));
	  if (Math.abs(nextScale - oldScale) < 0.001) return;
	  if (typeof originX === 'number' && typeof originY === 'number') {
	    const rect = imagePreviewImg.getBoundingClientRect();
	    const cx = rect.left + rect.width / 2;
	    const cy = rect.top + rect.height / 2;
	    imagePreviewX -= (originX - cx) * (nextScale / oldScale - 1);
	    imagePreviewY -= (originY - cy) * (nextScale / oldScale - 1);
	  }
	  imagePreviewScale = nextScale;
	  applyImagePreviewTransform();
	}
	function openImagePreview(src) {
	  imagePreviewImg.src = src;
	  resetImagePreviewTransform();
	  imagePreviewOverlay.classList.add('active');
	}
	function closeImagePreview() {
	  imagePreviewOverlay.classList.remove('active');
	  imagePreviewImg.removeAttribute('src');
	  resetImagePreviewTransform();
	}
	function flashImagePreviewButton(btn, label) {
	  const old = btn.textContent;
	  btn.textContent = label;
	  setTimeout(() => { btn.textContent = old; }, 1200);
	}
	async function copyImagePreview() {
	  const src = imagePreviewImg.src;
	  if (!src) return;
	  try {
	    if (navigator.clipboard && window.ClipboardItem) {
	      const blob = await (await fetch(src)).blob();
	      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
	      flashImagePreviewButton(imagePreviewCopy, 'Copied');
	      return;
	    }
	  } catch (_) { /* fall back to copying the data URL */ }
	  try {
	    await navigator.clipboard.writeText(src);
	    flashImagePreviewButton(imagePreviewCopy, 'Copied URL');
	  } catch (_) {
	    flashImagePreviewButton(imagePreviewCopy, 'Failed');
	  }
	}
	imagePreviewClose.addEventListener('click', closeImagePreview);
	imagePreviewZoomOut.addEventListener('click', () => zoomImagePreview(1 / 1.25));
	imagePreviewZoomIn.addEventListener('click', () => zoomImagePreview(1.25));
	imagePreviewReset.addEventListener('click', resetImagePreviewTransform);
	imagePreviewCopy.addEventListener('click', copyImagePreview);
	imagePreviewOverlay.addEventListener('click', (e) => {
	  if (e.target === imagePreviewOverlay) closeImagePreview();
	});
	imagePreviewStage.addEventListener('wheel', (e) => {
	  if (!imagePreviewOverlay.classList.contains('active')) return;
	  e.preventDefault();
	  zoomImagePreview(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
	}, { passive: false });
	imagePreviewStage.addEventListener('pointerdown', (e) => {
	  if (e.button !== 0) return;
	  e.preventDefault();
	  imagePreviewDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: imagePreviewX, baseY: imagePreviewY };
	  imagePreviewStage.classList.add('dragging');
	  imagePreviewStage.setPointerCapture(e.pointerId);
	});
	imagePreviewStage.addEventListener('pointermove', (e) => {
	  if (!imagePreviewDrag || imagePreviewDrag.pointerId !== e.pointerId) return;
	  imagePreviewX = imagePreviewDrag.baseX + e.clientX - imagePreviewDrag.startX;
	  imagePreviewY = imagePreviewDrag.baseY + e.clientY - imagePreviewDrag.startY;
	  applyImagePreviewTransform();
	});
	function endImagePreviewDrag(e) {
	  if (!imagePreviewDrag || imagePreviewDrag.pointerId !== e.pointerId) return;
	  imagePreviewDrag = null;
	  imagePreviewStage.classList.remove('dragging');
	}
	imagePreviewStage.addEventListener('pointerup', endImagePreviewDrag);
	imagePreviewStage.addEventListener('pointercancel', endImagePreviewDrag);
	function renderAttachments() {
	  attachmentsEl.innerHTML = '';
	  attachmentsEl.classList.toggle('visible', pastedImages.length > 0);
	  updateInputPlaceholder();
	  pastedImages.forEach((img, idx) => {
	    const chip = document.createElement('div');
	    chip.className = 'image-chip';
	    chip.title = 'Click to preview ' + (img.name || img.mimeType || 'pasted image');
	    chip.addEventListener('click', () => openImagePreview(img.dataUrl));
	    const preview = document.createElement('img');
	    preview.src = img.dataUrl;
	    preview.alt = img.name || 'pasted image';
	    const remove = document.createElement('button');
	    remove.type = 'button';
	    remove.title = 'Remove image';
	    remove.setAttribute('aria-label', 'Remove image');
	    remove.textContent = '×';
	    remove.addEventListener('click', (e) => {
	      e.preventDefault();
	      e.stopPropagation();
	      pastedImages.splice(idx, 1);
	      renderAttachments();
	      input.focus();
	    });
	    chip.appendChild(preview);
	    chip.appendChild(remove);
	    attachmentsEl.appendChild(chip);
	  });
	}
// Vision-model detection: keep in sync with modelSupportsVision() in extension TS.
function modelSupportsVisionJS(model) {
  const m = String(model || '').toLowerCase();
  if (!m.trim()) return false;
  return /(^|[-_/:.])(vl|vision|visual|multimodal|omni)([-_/:.]|$)/.test(m)
    || /(^|[-_/:.])v(ision)?\d*($|[-_/.])/.test(m)
    || m.includes('gpt-4o')
    || m.includes('gpt-4.1')
    || m.includes('o3')
    || m.includes('o4')
    || m.includes('qwen-vl')
    || m.includes('qwen2-vl')
    || m.includes('qwen2.5-vl')
    || m.includes('qwen3-vl')
    || m.includes('gemini')
    || m.includes('claude-3')
    || m.includes('claude-4')
    || m.includes('llava')
    || m.includes('minicpm-v')
    || m.includes('glm-4v')
    || m.includes('glm-4.1v')
    || m.includes('pixtral')
    || /(^|[/:-])gpt-5(?:[.-]\d+)?($|[/:-])/.test(m);
}
function modelEntryId(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.id === 'string') return entry.id;
  return '';
}
function modelEntrySupportsVision(entry) {
  if (entry && typeof entry === 'object' && typeof entry.supportsVision === 'boolean') return entry.supportsVision;
  return modelSupportsVisionJS(modelEntryId(entry));
}
function normalizeVideoResolutionJS(size) {
  const value = String(size || '').trim().toLowerCase();
  if (value === '480p') return { width: 854, height: 480, label: '854x480' };
  if (value === '720p') return { width: 1280, height: 720, label: '1280x720' };
  if (value === '1080p') return { width: 1920, height: 1080, label: '1920x1080' };
  const m = /^([1-9][0-9]{1,4})x([1-9][0-9]{1,4})$/.exec(value);
  if (m) {
    const width = Math.min(8192, Math.max(16, parseInt(m[1], 10)));
    const height = Math.min(8192, Math.max(16, parseInt(m[2], 10)));
    return { width, height, label: width + 'x' + height };
  }
  return { width: 1280, height: 720, label: '1280x720' };
}
function resizeImageDataUrlToVideoResolution(dataUrl, mimeType) {
  const target = normalizeVideoResolutionJS(modelsState.video && modelsState.video.resolution);
  return new Promise((resolve) => {
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) { resolve({ dataUrl, mimeType, resized: false, target }); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve({ dataUrl, mimeType, resized: false, target }); return; }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, target.width, target.height);
        const outMime = /^image\/jpe?g$/i.test(String(mimeType || '')) ? 'image/jpeg' : 'image/png';
        const out = canvas.toDataURL(outMime, outMime === 'image/jpeg' ? 0.92 : undefined);
        resolve({ dataUrl: out, mimeType: outMime, resized: true, target });
      } catch (_) {
        resolve({ dataUrl, mimeType, resized: false, target });
      }
    };
    img.onerror = () => resolve({ dataUrl, mimeType, resized: false, target });
    img.src = dataUrl;
  });
}
async function normalizeFirstFrameAttachment(img) {
  const resized = await resizeImageDataUrlToVideoResolution(img.dataUrl, img.mimeType || 'image/png');
  return {
    dataUrl: resized.dataUrl,
    mimeType: resized.mimeType || img.mimeType || 'image/png',
    name: img.name || 'pasted image',
    originalMimeType: img.mimeType,
    videoResolution: resized.target.label,
    resizedToVideoResolution: !!resized.resized
  };
}
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        resolve(await normalizeFirstFrameAttachment({ dataUrl: String(reader.result || ''), mimeType: file.type || 'image/png', name: file.name || 'pasted image' }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}
async function addImageFiles(files, sourceLabel) {
  const raw = Array.from(files || []).filter((f) => f && String(f.type || '').indexOf('image/') === 0);
  if (!raw.length) return;
  const slots = Math.max(0, 8 - pastedImages.length);
  if (slots <= 0) { addErrorMsg('⚠ 最多只能附加 8 张图片。'); return; }
  const added = [];
  for (const f of raw.slice(0, slots)) {
    try { added.push(await readImageFile(f)); } catch (_) { /* skip unreadable files */ }
  }
  if (!added.length) return;
  pastedImages.push(...added);
  renderAttachments();
  input.focus();
  if (raw.length > slots) addErrorMsg('⚠ 最多只能附加 8 张图片，已添加前 ' + slots + ' 张。');
}
attachImageBtn.addEventListener('click', () => attachImageInput.click());
attachImageInput.addEventListener('change', async () => {
  await addImageFiles(attachImageInput.files, 'selected');
  attachImageInput.value = '';
});
		input.addEventListener('paste', (e) => {
		  const dt = e.clipboardData;
		  if (!dt) return;

	  // Read string clipboard data synchronously during the paste event. In VS Code
	  // webviews, DataTransferItem.getAsString() can become unreliable once the
	  // event has returned, which made normal text paste disappear after we called
	  // preventDefault() to inspect possible HTML images.
	  const plainText = String(dt.getData('text/plain') || '');
	  const htmlText = String(dt.getData('text/html') || '');

	  const rawFiles = [];
	  const seenKeys = new Set();
	  const tryAddFile = (file) => {
	    if (!file || !/^image\//i.test(file.type || '')) return;
	    const key = [file.name || '', file.type || '', file.size || 0].join(':');
	    if (!seenKeys.has(key)) { seenKeys.add(key); rawFiles.push(file); }
	  };
	  Array.from(dt.files || []).forEach(tryAddFile);
	  Array.from(dt.items || []).forEach((it) => {
	    if (it.kind === 'file' && /^image\//i.test(it.type || '')) {
	      tryAddFile(it.getAsFile());
	    }
	  });

          const imageFromDataUrl = (dataUrl, name) => {
            const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl || '');
            if (!m) return null;
            return { dataUrl, mimeType: m[1], name: name || 'pasted image' };
          };
          const extractDataUrlImages = (text) => {
            const out = [];
            const re = new RegExp('data:image/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+', 'ig');
            let m;
            while ((m = re.exec(String(text || '')))) {
              const img = imageFromDataUrl(m[0].replace(/[\r\n]/g, ''), 'pasted image');
              if (img) out.push(img);
            }
            return out;
          };
          const inlineImages = [...extractDataUrlImages(htmlText), ...extractDataUrlImages(plainText)];

          // If there are no image files and no embedded data:image URLs, let the
          // browser perform a completely normal text paste. This preserves multiline
          // paste, selection replacement, undo behavior, and IME/browser quirks.
          if (rawFiles.length === 0 && inlineImages.length === 0) return;
          e.preventDefault();

          const insertTextAtCursor = (text) => {
            const s = String(text || '');
            if (!s) return false;
            const start = input.selectionStart || 0;
            const end = input.selectionEnd || start;
            const value = input.value || '';
            input.value = value.slice(0, start) + s + value.slice(end);
            const pos = start + s.length;
            try { input.setSelectionRange(pos, pos); } catch (_) {}
            autosizeInput();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          };

          (async () => {
            const images = [];
            for (const img of inlineImages) {
              try { images.push(await normalizeFirstFrameAttachment(img)); } catch (_) { /* skip */ }
            }
            for (const f of rawFiles) {
              try { images.push(await readImageFile(f)); } catch (_) { /* skip */ }
            }
            if (!images.length) {
              insertTextAtCursor(plainText);
              return;
            }
            const slots = Math.max(0, 8 - pastedImages.length);
            if (slots <= 0) { addErrorMsg('⚠ 最多只能附加 8 张图片。'); return; }
            pastedImages.push(...images.slice(0, slots));
            renderAttachments();
          })();
        });

sendBtn.addEventListener('click', () => {
  const text = input.value.trim();
  if (busy) {
    // While a run is in progress, the primary button is always Stop. Queueing is
    // handled by the dedicated queue button (or Enter shortcut below).
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  if (!text && pastedImages.length === 0) return;
  if (pastedImages.length > 0 && !currentModelSupportsVision) {
    // Soft warning only — the user may be on a gateway that supports vision
    // but whose model name doesn't match our heuristic. Allow sending and let
    // the server respond with an appropriate error if needed.
    console.warn('[burstcode] current model not flagged as vision-capable; sending anyway');
  }
  vscode.postMessage({ type: 'send', payload: { text, images: pastedImages, useRules: !!rulesToggle.checked, useSkills: !!skillsToggle.checked, useMcp: !!mcpToggle.checked } });
  pastedImages = [];
  renderAttachments();
  input.value = '';
  autosizeInput();
});

queueBtn.addEventListener('click', () => {
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', payload: { text, images: [], useRules: !!rulesToggle.checked, useSkills: !!skillsToggle.checked, useMcp: !!mcpToggle.checked } });
  input.value = '';
  autosizeInput();
  updateQueueButton();
});

input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.isComposing) return; // don't intercept while IME is composing
  if (e.ctrlKey || e.metaKey) {
    // Ctrl/Cmd + Enter -> insert newline at the cursor
    e.preventDefault();
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = input.value;
    input.value = value.slice(0, start) + '\n' + value.slice(end);
    input.selectionStart = input.selectionEnd = start + 1;
    return;
  }
  if (e.shiftKey) {
    // Shift+Enter -> default newline behavior
    return;
  }
  // Plain Enter -> send (or queue while busy if there's text)
  e.preventDefault();
  if (busy) {
    if (input.value.trim()) queueBtn.click();
    return;
  }
  sendBtn.click();
});

// Show/hide queue button when text changes while busy.
input.addEventListener('input', () => {
  updateQueueButton();
  updateSendButton();
});

// ============== Model picker ==============
// Single chat profile only. Background profile is managed via Settings UI
// (or via the 'BurstCode: Background Explorer Model' command).
const modelsState = {
  chat: { baseURL: '', model: '', models: [] },
  active: { model: '', supportsVision: false },
  fetched: { loading: false, models: null, error: null, fetchedAt: 0 },
  video: { resolution: '1280x720' }
};

function positionModelPicker() {
  const br = modelPickerBtn.getBoundingClientRect();
  const gap = 4;
  const left = Math.max(4, br.left);
  const maxRight = window.innerWidth - 4;
  const width = Math.min(320, Math.max(220, maxRight - left));

  // Apply width before measuring: the popover has max-height:60vh, so the
  // rendered height can be much smaller than scrollHeight when the model list is
  // long. Position from the actual rendered height to avoid a large visual gap.
  modelPicker.style.left = left + 'px';
  modelPicker.style.width = width + 'px';

  const renderedHeight = modelPicker.getBoundingClientRect().height;
  let top = br.top - renderedHeight - gap;
  if (top < 4) top = br.bottom + gap; // flip below if not enough room above
  modelPicker.style.top = top + 'px';
}

function setModelPickerOpen(open) {
  if (open) {
    renderModelPicker();
    modelPicker.classList.add('open');
    modelPickerBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(positionModelPicker);
  } else {
    modelPicker.classList.remove('open');
    modelPickerBtn.setAttribute('aria-expanded', 'false');
  }
}

function renderModelPickerLabel() {
  const labelEl = modelPickerBtn.querySelector('.label');
  if (!labelEl) return;
  const a = modelsState.active || { model: '', supportsVision: false };
  // Prefer the capability flag from /v1/models cache (more reliable than name heuristics).
  const fetchedModels = (modelsState.fetched && modelsState.fetched.models) || [];
  const fetchedEntry = fetchedModels.find(function(m) { return modelEntryId(m) === a.model; });
  currentModelSupportsVision =
    fetchedEntry !== undefined
      ? modelEntrySupportsVision(fetchedEntry)
      : (!!a.supportsVision || modelSupportsVisionJS(String(a.model || '')));
  // Always allow image paste — tooltip shows support status only.
  input.title = currentModelSupportsVision
    ? '支持粘贴图片（模型已标记为视觉/VL）'
    : '可尝试粘贴图片（模型未标记为视觉/VL，如网关支持也可发送）';
  if (!a.model) {
    labelEl.innerHTML = '<span class="ep">No model selected</span>';
    return;
  }
  labelEl.innerHTML = '<span class="model">' + escapeHtml(a.model) + '</span>';
}

function renderModelPicker() {
  modelPicker.innerHTML = '';
  const active = modelsState.active || { model: '' };
  const chat = modelsState.chat || { baseURL: '', model: '', models: [] };
  const cache = modelsState.fetched || { loading: false, models: null, error: null };

  const group = document.createElement('div');
  group.className = 'ep-group';

  const head = document.createElement('div');
  head.className = 'ep-head';
  const nm = document.createElement('span');
  nm.className = 'name';
  nm.textContent = 'Chat';
  const url = document.createElement('span');
  url.className = 'url';
  url.textContent = chat.baseURL || '(no baseURL)';
  url.title = chat.baseURL || '';
  const refresh = document.createElement('button');
  refresh.className = 'refresh';
  refresh.type = 'button';
  refresh.title = 'Fetch models from /v1/models';
  refresh.innerHTML = '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 0 1 9.7-3.5"/><path d="M12.5 2v3h-3"/><path d="M13.5 8a5.5 5.5 0 0 1-9.7 3.5"/><path d="M3.5 14v-3h3"/></svg><span>Refresh</span>';
  if (cache.loading) refresh.dataset.loading = 'true';
  refresh.onclick = (e) => {
    e.stopPropagation();
    modelsState.fetched = { ...cache, loading: true, error: null };
    renderModelPicker();
    positionModelPicker();
    vscode.postMessage({ type: 'refresh-models' });
  };
  head.appendChild(nm);
  head.appendChild(url);
  head.appendChild(refresh);
  group.appendChild(head);

  if (cache.error) {
    const err = document.createElement('div');
    err.className = 'ep-error';
    err.textContent = '⚠ ' + cache.error;
    group.appendChild(err);
  }

  // Compose the row list: manual model IDs first, then any fetched-only IDs.
  // Fetched entries are objects ({ id, supportsVision }); never render/pass the
  // object itself or VS Code will show "[object Object]" and selection breaks.
  const manual = (chat.models || []).map(modelEntryId).filter(Boolean);
  const fetched = Array.isArray(cache.models) ? cache.models : [];
  const seen = new Set();
  const rows = [];
  manual.forEach((id) => {
    if (!seen.has(id)) {
      seen.add(id);
      rows.push({ id, source: 'manual', supportsVision: modelSupportsVisionJS(id) });
    }
  });
  fetched.forEach((entry) => {
    const id = modelEntryId(entry);
    if (id && !seen.has(id)) {
      seen.add(id);
      rows.push({ id, source: 'fetched', supportsVision: modelEntrySupportsVision(entry) });
    }
  });

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-models';
    empty.textContent = cache.loading ? 'Loading...' : 'No models yet — refresh or add one below.';
    group.appendChild(empty);
  } else {
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'model-row';
      const isActive = r.id === active.model;
      if (isActive) row.classList.add('active');
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = isActive ? '✓' : '';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.id;
      name.title = r.id;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = r.supportsVision ? (r.source === 'manual' ? 'manual · VL' : 'fetched · VL') : (r.source === 'manual' ? 'manual' : 'fetched');
      row.appendChild(check);
      row.appendChild(name);
      row.appendChild(badge);
      if (r.source === 'manual') {
        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.title = 'Remove from chat profile';
        del.textContent = '✕';
        del.onclick = (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'remove-custom-model', payload: { model: r.id } });
        };
        row.appendChild(del);
      }
      row.onclick = () => {
        vscode.postMessage({ type: 'select-model', payload: { model: r.id } });
        setModelPickerOpen(false);
      };
      group.appendChild(row);
    });
  }

  // Manual-add input
  const addRow = document.createElement('div');
  addRow.className = 'add-row';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.placeholder = 'Add custom model id...';
  addInput.spellcheck = false;
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  const submitAdd = () => {
    const id = addInput.value.trim();
    if (!id) return;
    vscode.postMessage({ type: 'add-custom-model', payload: { model: id, activate: true } });
    addInput.value = '';
    setModelPickerOpen(false);
  };
  addBtn.onclick = (e) => { e.stopPropagation(); submitAdd(); };
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
    e.stopPropagation();
  });
  addInput.addEventListener('click', (e) => e.stopPropagation());
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  group.appendChild(addRow);

  modelPicker.appendChild(group);

  const footer = document.createElement('div');
  footer.className = 'footer';
  const link = document.createElement('a');
  link.textContent = 'Open chat profile settings →';
  link.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'open-config' }); setModelPickerOpen(false); };
  footer.appendChild(link);
  modelPicker.appendChild(footer);
}

modelPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setModelPickerOpen(!modelPicker.classList.contains('open'));
});
modelPicker.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  if (modelPicker.classList.contains('open')) setModelPickerOpen(false);
});

// Esc closes the model picker first; otherwise cancels an in-flight run.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modelPicker.classList.contains('open')) {
    e.preventDefault();
    setModelPickerOpen(false);
    return;
  }
  if (busy) {
    e.preventDefault();
    vscode.postMessage({ type: 'cancel' });
  }
});
newBtn.addEventListener('click', () => vscode.postMessage({ type: 'reset' }));
cfgBtn.addEventListener('click', () => vscode.postMessage({ type: 'open-config' }));

// Pending-edits banner: persistent controls for the queued edit set.
pendingReviewBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  vscode.postMessage({ type: 'review-edits' });
});
// Click the title to collapse/expand the changed-file list.
pendingTitleRow.addEventListener('click', () => {
  pendingBanner.classList.toggle('collapsed');
});
pendingAcceptBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  pendingAcceptBtn.disabled = true;
  pendingRejectBtn.disabled = true;
  vscode.postMessage({ type: 'accept-all-edits' });
});
pendingRejectBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  pendingAcceptBtn.disabled = true;
  pendingRejectBtn.disabled = true;
  vscode.postMessage({ type: 'reject-all-edits' });
});

historyBtn.addEventListener('click', () => {
  const open = historyEl.classList.toggle('open');
  if (open) {
    // Close the other overlays so they don't stack.
    lessonsEl.classList.remove('open');
    vscode.postMessage({ type: 'request-sessions' });
    renderHistory();
  }
});
document.addEventListener('click', (ev) => {
  if (!historyEl.classList.contains('open')) return;
  if (historyEl.contains(ev.target) || historyBtn.contains(ev.target)) return;
  historyEl.classList.remove('open');
});

lessonsBtn.addEventListener('click', () => {
  const open = lessonsEl.classList.toggle('open');
  if (open) {
    historyEl.classList.remove('open');
    lessonsAdding = false;
    vscode.postMessage({ type: 'request-lessons' });
    renderLessons();
  }
});
document.addEventListener('click', (ev) => {
  if (!lessonsEl.classList.contains('open')) return;
  if (lessonsEl.contains(ev.target) || lessonsBtn.contains(ev.target)) return;
  lessonsEl.classList.remove('open');
  lessonsAdding = false;
});

// Ask the host for the latest model list once the script has fully loaded.
vscode.postMessage({ type: 'request-models' });
vscode.postMessage({ type: 'request-sessions' });
vscode.postMessage({ type: 'request-lessons' });
