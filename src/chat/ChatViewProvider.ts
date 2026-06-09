import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../util/Logger';
import { DependencyGuard } from '../deps/DependencyGuard';
import { HunkApplier, PendingState } from '../edits/HunkApplier';
import {
  OpenAIClient,
  readLLMConfig,
  readChatProfile,
  setChatModel,
  addChatModel,
  removeChatModel,
  fetchProfileModels,
  getCachedFetchedModels,
  writeCachedFetchedModels,
  ChatMessage
} from '../llm/OpenAIClient';
import { LspBridge } from '../lsp/LspBridge';
import { estimateMessagesTokens } from '../llm/tokenizer';
import { AgentLoop } from '../agent/AgentLoop';
import { Tool } from '../agent/tools/types';
import { buildReadFileTool, buildWriteFileTool, buildCollectContextTool, listDirTool, grepSearchTool, workspaceOutlineTool } from '../agent/tools/core';
import { readWebpageTool, webSearchTool } from '../agent/tools/web';
import { buildImageTool } from '../agent/tools/image';
import { WorkspaceIndex } from '../context/WorkspaceIndex';
import { buildSystemPrompt } from '../agent/prompts';
import { buildLspTools } from '../agent/tools/lsp';
import { buildLangTools } from '../agent/tools/lang';
import { buildEditTools, AskUserSpec } from '../agent/tools/edits';
import { buildPlanTool, PlanStep } from '../agent/tools/plan';
import { buildLessonTools } from '../agent/tools/lessons';
import { buildShellTools } from '../agent/tools/shell';
import { buildContextTools } from '../agent/tools/context';
import { buildSubagentTool } from '../agent/tools/subagent';
import { LessonStore, renderLessonsBlock } from '../memory/LessonStore';
import { readGlobalRules, readGlobalSkills } from '../memory/GlobalRules';
import { CheckpointInfo, GitCheckpoint } from '../git/GitCheckpoint';
import {
  Session,
  SessionCheckpoint,
  SessionStatus,
  SessionStore,
  buildTranscript,
  createSessionId,
  deriveTitle
} from './SessionStore';
import type { ExplorerStatus } from '../background/BackgroundExplorer';

interface InboundMessage {
  type: string;
  payload?: unknown;
}

interface OutboundMessage {
  type: string;
  payload?: unknown;
}

/**
 * Snapshot of an in-flight agent run for a single session. Kept in memory so
 * the webview can replay the streaming UI when the user switches AWAY and
 * then back to a running session.
 *
 * What we capture:
 *   - `iter`                  current iteration index (0-based) emitted by AgentLoop
 *   - `assistantText`         accumulated assistant-delta bytes not yet finalized
 *   - `reasoningText`         accumulated reasoning-delta bytes not yet finalized
 *   - `runningTools`          tool calls currently in-flight (id -> snapshot)
 *   - `toolProgress`          last-N progress lines per running tool id
 *   - `iterPills` / `autoPills`/`resumePills`  small banner pills emitted by the loop
 *   - `plan`                  latest plan steps (also persisted on the Session)
 *   - `pendingAsk`            an open ask-user prompt (if any)
 *   - `lastStatus`            most recent status label so the bottom pill stays in sync
 */
interface RunningToolSnap {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
}

interface PillSnap {
  kind: 'iteration' | 'auto-continue' | 'auto-resume';
  payload: unknown;
}

interface PendingAskSnap {
  id: string;
  question: string;
  inputType: 'single' | 'multi' | 'text';
  options?: Array<{ label: string; description?: string }>;
  allowCustomText?: boolean;
  placeholder?: string;
}

interface SessionLive {
  iter: number;
  assistantText: string;
  reasoningText: string;
  /**
   * Assistant text segments already finalized (via `assistant-message`)
   * WITHIN the current iteration but BEFORE the current `assistantText`
   * stream. The agent loop emits one such finalized segment every time it
   * auto-continues after a `finish_reason=length` truncation. Without
   * retaining them here, a user who switches away and back mid-run loses
   * every segment except the last one still streaming — the live snapshot
   * used to drop them by resetting `assistantText` to ''.
   */
  finalizedAssistantTexts: string[];
  runningTools: Map<string, RunningToolSnap>;
  toolProgress: Map<string, string[]>;
  pills: PillSnap[];
  lastStatus?: { state: string; label: string };
  pendingAsk?: PendingAskSnap;
}

function emptyLive(): SessionLive {
  return {
    iter: 0,
    assistantText: '',
    reasoningText: '',
    finalizedAssistantTexts: [],
    runningTools: new Map(),
    toolProgress: new Map(),
    pills: []
  };
}

interface RunContext {
  sessionId: string;
  session: Session;
  cts: vscode.CancellationTokenSource;
  live: SessionLive;
  /** Pending askUser promise — resolved by the webview message. */
  pendingAsk?: { resolve: (value: string) => void; id: string; spec: PendingAskSnap };
}

/** Workspace-state key for the persisted browser-style open-tab working set. */
const KEY_OPEN_TABS = 'burstcode.chat.openTabs';

/** Virtual scheme backing the LEFT side of a rollback-preview diff (pre-prompt snapshot). */
const ROLLBACK_SNAPSHOT_SCHEME = 'burstcode-rollback';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'burstcode.chatView';

  private view?: vscode.WebviewView;
  private currentSession?: Session;
  /**
   * Per-session in-flight run contexts. Multiple sessions can be running
   * concurrently; the webview only renders events for the session that is
   * currently visible, but the backend keeps live snapshots so switching
   * back to a still-running session replays the in-flight state.
   */
  private readonly runs = new Map<string, RunContext>();
  /**
   * Browser-style "open tab" working set. Distinct from the history list:
   * history is every persisted session, openTabIds is the subset the user
   * has explicitly pulled into the foreground tab strip. Closing a tab
   * removes the id here but does NOT delete the underlying session \u2014 the
   * user can re-open it from the history overlay later. Persisted across
   * reloads so opened tabs survive a VS Code restart.
   */
  private openTabIds = new Set<string>();
  /**
   * One-shot guard for the "checkpoint creation failed" popup. Once shown for
   * the current extension session we silently log subsequent failures and let
   * the rollback-button tooltip carry the per-message reason instead of
   * spamming the user with a popup on every prompt.
   */
  private checkpointFailureNotified = false;
  private configSub?: vscode.Disposable;
  private pendingEditsSub?: vscode.Disposable;
  /**
   * Lazily-created virtual content provider that serves the pre-prompt
   * snapshot of a file for the rollback-confirmation diff (LEFT = checkpoint
   * snapshot, RIGHT = current file on disk). Keyed by the virtual URI string.
   */
  private rollbackSnapshots?: Map<string, string>;
  private rollbackSnapshotSub?: vscode.Disposable;
  private readonly sessions: SessionStore;
  private readonly lessons: LessonStore;
  private readonly foregroundActivityEmitter = new vscode.EventEmitter<string>();
  readonly onDidForegroundActivity: vscode.Event<string> = this.foregroundActivityEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly depGuard: DependencyGuard,
    private readonly applier: HunkApplier,
    private readonly gitCheckpoint: GitCheckpoint,
    private readonly workspaceIndex: WorkspaceIndex
  ) {
    this.sessions = new SessionStore(context.workspaceState);
    this.lessons = new LessonStore(context.workspaceState);
    // Restore the open-tab working set. Filter out any ids whose session has
    // since been deleted so we never render orphan tabs.
    const persisted = context.workspaceState.get<string[]>(KEY_OPEN_TABS) ?? [];
    const validIds = new Set(this.sessions.list().map((m) => m.id));
    for (const id of persisted) {
      if (validIds.has(id)) this.openTabIds.add(id);
    }
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('burstcode.llm')) {
        this.broadcastModels();
        this.broadcastContextUsage();
      }
    });
    this.pendingEditsSub = this.applier.onPendingStateChange((state) => {
      // The emitted `state` is global; re-derive the view scoped to the
      // currently-visible session so each tab only ever shows its own edits.
      this.broadcastPendingEdits();
      // Persist a small note into the session messages so the next agent run
      // sees what the user did in between turns. The model will read this as
      // ordinary user-side context and react accordingly.
      if (state.recentDecision && this.currentSession) {
        // Only inject the inter-turn note when no agent run is active for
        // this session. When a run IS active, AgentLoop's decisionBuffer
        // already captures this same event and injects it at the correct
        // iteration boundary — injecting here too would duplicate the message.
        if (!this.runs.has(this.currentSession.id)) {
          this.currentSession.messages.push({
            role: 'user',
            content: `(System note) The user reviewed the previously queued edits — ${state.recentDecision}. Take this into account on the next instruction.`
          });
          void this.persistCurrentSession();
        }
      }
    });
    this.context.subscriptions.push({
      dispose: () => {
        this.configSub?.dispose();
        this.pendingEditsSub?.dispose();
        this.foregroundActivityEmitter.dispose();
      }
    });
  }

  /** True while ANY chat-driven agent run is active. Used by BackgroundExplorer to defer idle work. */
  isBusy(): boolean {
    return this.runs.size > 0;
  }

  /** Run context for the currently-visible session, if any. */
  private currentRun(): RunContext | undefined {
    return this.currentSession ? this.runs.get(this.currentSession.id) : undefined;
  }

  /** Resolve the effective status (live runs override the persisted field). */
  private effectiveStatus(sessionId: string, persisted?: SessionStatus): SessionStatus | undefined {
    if (this.runs.has(sessionId)) return 'running';
    return persisted;
  }

  /** Mark a session as "open" in the foreground tab strip. Idempotent. */
  private openTab(id: string): void {
    if (!id) return;
    if (this.openTabIds.has(id)) return;
    this.openTabIds.add(id);
    void this.persistOpenTabs();
  }

  /** Remove a session from the tab strip. Does NOT delete it from history. */
  private closeTab(id: string): void {
    if (!this.openTabIds.delete(id)) return;
    void this.persistOpenTabs();
    // If the closed tab was the active one, fall back to another open tab
    // (most-recently-updated) so the user lands on a real session rather
    // than a blank panel. If nothing is left open, drop to empty state.
    if (this.currentSession?.id === id) {
      const fallback = this.pickFallbackTab(id);
      if (fallback) {
        void this.loadSession(fallback);
      } else {
        this.currentSession = undefined;
        this.post({ type: 'reset' });
        this.broadcastContextUsage();
        this.broadcastSessions();
      }
    } else {
      this.broadcastSessions();
    }
  }

  /**
   * Bulk close. If `keep` is provided, every tab EXCEPT that id is removed;
   * otherwise all tabs are closed. Batches the work to avoid one persist /
   * broadcast roundtrip per removed tab.
   */
  private closeAllTabs(keep?: string): void {
    let changed = false;
    for (const id of Array.from(this.openTabIds)) {
      if (keep && id === keep) continue;
      if (this.openTabIds.delete(id)) changed = true;
    }
    if (!changed) return;
    void this.persistOpenTabs();
    // Reconcile the active session with what's still open.
    const activeId = this.currentSession?.id;
    if (activeId && !this.openTabIds.has(activeId)) {
      if (keep && this.openTabIds.has(keep)) {
        void this.loadSession(keep);
        return;
      }
      // Nothing meaningful left to show \u2014 reset to the empty state.
      this.currentSession = undefined;
      this.post({ type: 'reset' });
      this.broadcastContextUsage();
    }
    this.broadcastSessions();
  }

  /** Pick the most recently-updated open tab other than `exclude`. */
  private pickFallbackTab(exclude: string): string | undefined {
    const candidates = this.sessions.list().filter((s) => s.id !== exclude && this.openTabIds.has(s.id));
    return candidates[0]?.id;
  }

  private async persistOpenTabs(): Promise<void> {
    try {
      await this.context.workspaceState.update(KEY_OPEN_TABS, Array.from(this.openTabIds));
    } catch (err) {
      this.logger.warn('Failed to persist open tabs', String(err));
    }
  }

  /**
   * Push the pending-edits banner state for the CURRENTLY-VISIBLE session only.
   * The HunkApplier queue is global, but each chat tab must see and act on just
   * the edits its own session produced, so we always re-derive the per-session
   * snapshot here rather than forwarding the global emitted state.
   */
  private broadcastPendingEdits(): void {
    if (!this.view) return;
    // A brand-new chat has no session id yet and owns NO pending edits. Passing
    // `undefined` to getPendingState() matches the GLOBAL queue (legacy view),
    // which would surface the previously-visible session's edits in the banner.
    // Post an explicitly-empty snapshot in that case so the banner clears.
    const sid = this.currentSession?.id;
    const state = sid
      ? this.applier.getPendingState(sid)
      : { files: 0, hunks: 0, fileList: [], latestSummary: '' };
    this.post({ type: 'pending-edits', payload: state });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: InboundMessage) => {
      void this.handleMessage(msg).catch((err) => {
        const message = String((err as Error)?.message ?? err);
        this.logger.error('Webview message failed', message);
        this.post({ type: 'action-error', payload: { action: msg.type, message } });
      });
    });
    // Send the initial model list once the webview is ready.
    this.broadcastModels();
    this.broadcastSessions();
    this.broadcastLessons();
    this.broadcastContextUsage();
    this.broadcastBackgroundStatus();
    // Re-broadcast any pending-edit queue so a reopened panel shows the banner.
    this.broadcastPendingEdits();
  }

  private broadcastSessions(): void {
    if (!this.view) return;
    const raw = this.sessions.list();
    // Overlay live status from the in-memory runs map so a session that just
    // started (but hasn't been persisted yet) still shows up as 'running' in
    // the history list. Persisted status is the source of truth otherwise.
    const sessions = raw.map((s) => ({
      ...s,
      status: this.effectiveStatus(s.id, s.status) ?? 'idle'
    }));
    // A session that just started its FIRST run won't be in the persisted
    // index yet (we save lazily). Surface it anyway so the user sees the
    // running pill immediately.
    for (const [id, ctx] of this.runs.entries()) {
      if (!sessions.find((s) => s.id === id)) {
        sessions.unshift({
          id,
          title: ctx.session.title,
          createdAt: ctx.session.createdAt,
          updatedAt: Date.now(),
          status: 'running'
        });
      }
    }
    this.post({
      type: 'sessions',
      payload: {
        sessions,
        activeId: this.currentSession?.id,
        // The tab strip filters by this set; the history overlay ignores it
        // and shows every persisted session.
        openIds: Array.from(this.openTabIds)
      }
    });
  }

  private broadcastLessons(): void {
    if (!this.view) return;
    this.post({
      type: 'lessons',
      payload: { lessons: this.lessons.list() }
    });
  }

  /**
   * Latest BackgroundExplorer status, fed in from extension.ts via
   * setBackgroundStatus(). Cached so the chat panel can re-render the pill
   * immediately on (re)open without waiting for the next status event.
   */
  private bgStatus?: ExplorerStatus;

  /** Called by extension.ts on every BackgroundExplorer status transition. */
  setBackgroundStatus(s: ExplorerStatus): void {
    this.bgStatus = s;
    this.broadcastBackgroundStatus();
  }

  private broadcastBackgroundStatus(): void {
    if (!this.view || !this.bgStatus) return;
    this.post({ type: 'bg-status', payload: this.bgStatus });
  }

  private broadcastContextUsage(): void {
    if (!this.view) return;
    const cfg = readLLMConfig();
    const used = this.currentSession
      ? estimateMessagesTokens(
          this.currentSession.messages as Array<{ role: string; content: unknown }>
        )
      : 0;
    this.post({
      type: 'context-usage',
      payload: { used, max: cfg.contextWindow }
    });
  }

  private broadcastModels(): void {
    if (!this.view) return;
    const chat = readChatProfile();
    const activeModel = chat.model || chat.models[0] || '';
    const cached = getCachedFetchedModels(this.context.globalState, chat.baseURL);
    this.post({
      type: 'models',
      payload: {
        active: { model: activeModel },
        chat: {
          baseURL: chat.baseURL,
          model: activeModel,
          models: chat.models.slice()
        },
        fetched: cached
      }
    });
  }

  newChat(): void {
    this.currentSession = undefined;
    this.post({ type: 'reset' });
    this.broadcastSessions();
    this.broadcastContextUsage();
    // A fresh chat has no pending edits of its own; clear the banner.
    this.broadcastPendingEdits();
  }

  private async loadSession(id: string): Promise<void> {
    // Prefer the live session held by an active run (its messages array is
    // the one the AgentLoop is currently mutating). Falls back to disk for
    // idle sessions.
    const live = this.runs.get(id)?.session;
    const s = live ?? this.sessions.get(id);
    if (!s) {
      vscode.window.showWarningMessage('BurstCode: session not found.');
      this.broadcastSessions();
      return;
    }
    this.currentSession = s;
    // Loading a session always promotes it into the tab strip — the user
    // explicitly wanted to look at it.
    this.openTab(s.id);
    this.post({ type: 'reset' });
    this.post({
      type: 'load-session',
      payload: {
        id: s.id,
        title: s.title,
        transcript: buildTranscript(s.messages, s.checkpoints),
        plan: s.plan ?? [],
        status: this.effectiveStatus(s.id, s.status) ?? 'idle'
      }
    });
    // If a run is still in flight for this session, replay the in-memory
    // live snapshot so the user sees streaming text / running tools / iter
    // pills they would have seen if they'd never switched away.
    const ctx = this.runs.get(id);
    if (ctx) {
      this.post({ type: 'live-state-replay', payload: this.serializeLive(ctx) });
    }
    this.broadcastSessions();
    this.broadcastContextUsage();
    // Refresh the pending-edits banner so it shows THIS session's edits only.
    this.broadcastPendingEdits();
  }

  /** Build a JSON-safe snapshot of the in-flight run state for replay. */
  private serializeLive(ctx: RunContext): unknown {
    const live = ctx.live;
    const runningTools = Array.from(live.runningTools.entries()).map(([id, t]) => ({
      id,
      name: t.name,
      args: t.args,
      startedAt: t.startedAt,
      progress: live.toolProgress.get(id) ?? []
    }));
    return {
      sessionId: ctx.sessionId,
      iter: live.iter,
      assistantText: live.assistantText,
      reasoningText: live.reasoningText,
      finalizedAssistantTexts: live.finalizedAssistantTexts,
      runningTools,
      pills: live.pills,
      lastStatus: live.lastStatus,
      pendingAsk: live.pendingAsk
    };
  }

  private async deleteSession(id: string): Promise<void> {
    // Refuse to delete a session that is still running — cancel it first.
    if (this.runs.has(id)) {
      vscode.window.showWarningMessage('BurstCode: stop this session before deleting it.');
      return;
    }
    // Confirm via a VS Code native modal. We can't rely on the webview's
    // `confirm()` since it is silently a no-op inside vscode webviews —
    // calling it returns undefined and the delete path was being skipped.
    const meta = this.sessions.list().find((s) => s.id === id);
    const title = meta?.title ?? 'this chat';
    const choice = await vscode.window.showWarningMessage(
      `Delete chat "${title}"? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;
    await this.sessions.delete(id);
    // Also evict from the tab working set so we don't leave an orphan tab
    // pointing at a now-deleted session.
    if (this.openTabIds.delete(id)) {
      void this.persistOpenTabs();
    }
    if (this.currentSession?.id === id) {
      this.currentSession = undefined;
      this.post({ type: 'reset' });
    }
    this.broadcastSessions();
  }

  /** Cancel the run for a specific session (e.g. from history's stop button). */
  private cancelSession(id: string): void {
    const ctx = this.runs.get(id);
    if (!ctx) return;
    ctx.cts.cancel();
  }

  private ensureSessionForUserText(userText: string): Session {
    if (this.currentSession) return this.currentSession;
    const now = Date.now();
    this.currentSession = {
      id: createSessionId(),
      title: deriveTitle(userText),
      createdAt: now,
      updatedAt: now,
      messages: [],
      plan: []
    };
    // Brand-new chats auto-join the tab strip.
    this.openTab(this.currentSession.id);
    return this.currentSession;
  }

  private ensureSystemMessageSlot(session: Session): void {
    if (session.messages.some((m) => m.role === 'system')) return;
    session.messages.unshift({ role: 'system', content: '' });
    session.checkpoints = (session.checkpoints ?? []).map((c) => ({
      ...c,
      messageIndex: c.messageIndex + 1
    }));
  }

  private async persistCurrentSession(): Promise<void> {
    if (!this.currentSession) return;
    this.currentSession.updatedAt = Date.now();
    try {
      await this.sessions.save(this.currentSession);
    } catch (err) {
      this.logger.error('Failed to persist session', String(err));
    }
    this.broadcastSessions();
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'send':
        await this.runAgent(String((msg.payload as { text: string })?.text ?? ''));
        break;
      case 'cancel':
        this.currentRun()?.cts.cancel();
        break;
      case 'cancel-session': {
        const sid = String((msg.payload as { id?: string })?.id ?? '').trim();
        if (sid) this.cancelSession(sid);
        break;
      }
      case 'close-tab': {
        const sid = String((msg.payload as { id?: string })?.id ?? '').trim();
        if (sid) this.closeTab(sid);
        break;
      }
      case 'close-all-tabs':
        this.closeAllTabs();
        break;
      case 'close-other-tabs': {
        const sid = String((msg.payload as { id?: string })?.id ?? '').trim();
        if (sid) this.closeAllTabs(sid);
        break;
      }
      case 'accept-all-edits':
        await this.applier.acceptAll(this.currentSession?.id);
        break;
      case 'reject-all-edits':
        await this.applier.rejectAll(this.currentSession?.id);
        break;
      case 'review-edits': {
        const uri = String((msg.payload as { uri?: string })?.uri ?? '').trim();
        if (uri) {
          await this.applier.openDiffForFile(uri);
        } else {
          await this.applier.openPendingDiff();
        }
        break;
      }
      case 'review-edit-file': {
        // Clicking a file inside a propose_edit card: open the accept/reject
        // diff editor and scroll to the nearest change. If the file no longer
        // has pending edits (already accepted/rejected), fall back to opening
        // the file at the changed line.
        const p = (msg.payload ?? {}) as { path?: string; line?: number };
        const filePath = String(p.path ?? '').trim();
        if (!filePath) break;
        const line = typeof p.line === 'number' && p.line > 0 ? p.line : undefined;
        try {
          const opened = await this.applier.revealEditInDiff(filePath, line);
          if (!opened) {
            await this.handleMessage({ type: 'open-file', payload: { path: filePath, line: line ?? 0 } });
          }
        } catch (err) {
          this.logger.warn('review-edit-file failed', String(err));
        }
        break;
      }
      case 'rollback': {
        const payload = (msg.payload ?? {}) as { ref?: string; messageIndex?: number };
        await this.rollbackToCheckpoint(String(payload.ref ?? ''), Number(payload.messageIndex ?? -1));
        break;
      }
      case 'ask-user-response': {
        const payload = (msg.payload ?? {}) as { answer?: string; sessionId?: string; id?: string };
        const answer = String(payload.answer ?? '');
        const askId = String(payload.id ?? '');
        // Find which session's pending ask this belongs to. Prefer the
        // explicit sessionId (sent by the webview when answering), then fall
        // back to matching by ask id (older messages), then the current view.
        const target =
          (payload.sessionId && this.runs.get(payload.sessionId)) ||
          (askId
            ? Array.from(this.runs.values()).find((r) => r.pendingAsk?.id === askId)
            : undefined) ||
          this.currentRun();
        if (target?.pendingAsk) {
          target.pendingAsk.resolve(answer);
          target.pendingAsk = undefined;
          target.live.pendingAsk = undefined;
        }
        break;
      }
      case 'reset':
        this.newChat();
        break;
      case 'load-session':
        await this.loadSession(String((msg.payload as { id: string })?.id ?? ''));
        break;
      case 'delete-session':
        await this.deleteSession(String((msg.payload as { id: string })?.id ?? ''));
        break;
      case 'request-sessions':
        this.broadcastSessions();
        break;
      case 'open-config':
        try {
          await vscode.commands.executeCommand('workbench.view.extension.burstcode');
        } catch {
          /* container may not exist yet — fall through to focusing the view directly */
        }
        try {
          await vscode.commands.executeCommand('burstcode.basicInfoView.focus');
        } catch {
          // last-resort fallback: open the raw settings page
          await vscode.commands.executeCommand('workbench.action.openSettings', 'burstcode');
        }
        break;
      case 'select-model': {
        const p = (msg.payload ?? {}) as { model?: string };
        const model = String(p.model ?? '').trim();
        if (model) {
          await setChatModel(model);
          // onDidChangeConfiguration will broadcast the new active selection.
        }
        break;
      }
      case 'add-custom-model': {
        const p = (msg.payload ?? {}) as { model?: string; activate?: boolean };
        const model = String(p.model ?? '').trim();
        if (model) {
          await addChatModel(model);
          if (p.activate !== false) {
            await setChatModel(model);
          }
        }
        break;
      }
      case 'remove-custom-model': {
        const p = (msg.payload ?? {}) as { model?: string };
        const model = String(p.model ?? '').trim();
        if (model) {
          await removeChatModel(model);
        }
        break;
      }
      case 'refresh-models': {
        const chat = readChatProfile();
        if (!chat.baseURL) {
          this.post({
            type: 'models-fetched',
            payload: { error: 'baseURL is empty — set burstcode.llm.chat.baseURL first' }
          });
          break;
        }
        try {
          const models = await fetchProfileModels({
            baseURL: chat.baseURL,
            apiKey: chat.apiKey,
            allowSelfSignedCerts: chat.allowSelfSignedCerts
          });
          // Persist so the picker shows these immediately on next reopen
          // without re-hitting the network.
          await writeCachedFetchedModels(this.context.globalState, chat.baseURL, models);
          this.post({
            type: 'models-fetched',
            payload: { models, fetchedAt: Date.now() }
          });
        } catch (err) {
          this.post({
            type: 'models-fetched',
            payload: { error: String((err as Error)?.message ?? err) }
          });
        }
        break;
      }
      case 'request-models':
        this.broadcastModels();
        break;
      case 'bg-menu':
        // Forward to the registered command so the BackgroundExplorer ref
        // lives in one place (extension.ts owns it).
        void vscode.commands.executeCommand('burstcode.background.menu');
        break;
      case 'request-lessons':
        this.broadcastLessons();
        break;
      case 'update-lesson': {
        const p = (msg.payload ?? {}) as {
          id?: string;
          file?: string;
          symbol?: string;
          tags?: string[];
          content?: string;
          important?: boolean;
        };
        const content = String(p.content ?? '').trim();
        if (!content) {
          this.broadcastLessons();
          break;
        }
        await this.lessons.upsert({
          id: p.id ? String(p.id) : undefined,
          scope: {
            file: p.file ? String(p.file) : undefined,
            symbol: p.symbol ? String(p.symbol) : undefined,
            tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined
          },
          content,
          important: p.important === true
        });
        this.broadcastLessons();
        break;
      }
      case 'delete-lesson': {
        const id = String((msg.payload as { id?: string })?.id ?? '').trim();
        if (!id) break;
        // Confirm via VS Code modal (webview confirm() is a no-op).
        const choice = await vscode.window.showWarningMessage(
          'Delete this lesson? This cannot be undone.',
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') break;
        await this.lessons.remove(id);
        this.broadcastLessons();
        break;
      }
      case 'clear-lessons': {
        const count = this.lessons.list().length;
        if (count === 0) break;
        const choice = await vscode.window.showWarningMessage(
          `Delete all ${count} lessons? This cannot be undone.`,
          { modal: true },
          'Delete All'
        );
        if (choice !== 'Delete All') break;
        await this.lessons.clear();
        this.broadcastLessons();
        break;
      }
      case 'open-file': {
        const p = (msg.payload ?? {}) as { path?: string; line?: number };
        const filePath = String(p.path ?? '').trim();
        if (!filePath) break;
        try {
          let uri: vscode.Uri;
          if (filePath.startsWith('/') || (filePath.length > 2 && filePath[1] === ':')) {
            uri = vscode.Uri.file(filePath);
          } else {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) break;
            uri = vscode.Uri.joinPath(folder.uri, filePath);
          }
          const doc = await vscode.workspace.openTextDocument(uri);
          const line = typeof p.line === 'number' && p.line > 0 ? p.line - 1 : 0;
          await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(line, 0, line, 0),
            preserveFocus: false
          });
        } catch (err) {
          this.logger.warn('open-file failed', String(err));
        }
        break;
      }
      case 'find-symbol': {
        const p = (msg.payload ?? {}) as { name?: string };
        const symbolName = String(p.name ?? '').trim();
        if (!symbolName) break;
        try {
          const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', symbolName
          );
          if (symbols && symbols.length > 0) {
            const sym = symbols[0];
            const doc = await vscode.workspace.openTextDocument(sym.location.uri);
            await vscode.window.showTextDocument(doc, {
              selection: sym.location.range,
              preserveFocus: false
            });
          }
        } catch (err) {
          this.logger.warn('find-symbol failed', String(err));
        }
        break;
      }
      default:
        this.logger.warn('Unknown webview message', msg.type);
    }
  }

  private post(msg: OutboundMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Build the system prompt for an upcoming agent run by combining the static
   * protocol with a freshly-walked workspace outline. Falls back gracefully if
   * no folder is open or the walk fails.
   */
  private async buildSystemPromptForRun(taskText = ''): Promise<string> {
    const lessonsRender = renderLessonsBlock(this.lessons.list());
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentPlan = this.currentSession?.plan;
    const globalRules = root
      ? await readGlobalRules(root).catch((err) => {
        this.logger.warn('Failed to read global rules', String(err));
        return undefined;
      })
      : undefined;
    const globalSkills = root
      ? await readGlobalSkills(root, taskText).catch((err) => {
        this.logger.warn('Failed to read global skills', String(err));
        return undefined;
      })
      : undefined;
    if (!root) {
      return buildSystemPrompt({
        globalRules: globalRules?.text,
        globalRulesTruncated: globalRules?.truncated,
        globalSkills: globalSkills?.text,
        globalSkillsTruncated: globalSkills?.truncated,
        lessonsBlock: lessonsRender.text,
        lessonsTruncated: lessonsRender.truncated,
        currentPlan
      });
    }
    try {
      // Hot path: served from the WorkspaceIndex cache that was warmed at
      // activation and is invalidated on file create/delete/rename. We pay
      // for a disk walk only when the cache is cold (first call after
      // activation or after a structural change).
      const outline = await this.workspaceIndex.getOutline();
      return buildSystemPrompt({
        workspaceRoot: root,
        workspaceOutline: outline.text,
        outlineTruncated: outline.truncated,
        globalRules: globalRules?.text,
        globalRulesTruncated: globalRules?.truncated,
        globalSkills: globalSkills?.text,
        globalSkillsTruncated: globalSkills?.truncated,
        lessonsBlock: lessonsRender.text,
        lessonsTruncated: lessonsRender.truncated,
        currentPlan,
        contextToolsAvailable: true
      });
    } catch (err) {
      this.logger.warn('Failed to build workspace outline', String(err));
      return buildSystemPrompt({
        workspaceRoot: root,
        globalRules: globalRules?.text,
        globalRulesTruncated: globalRules?.truncated,
        globalSkills: globalSkills?.text,
        globalSkillsTruncated: globalSkills?.truncated,
        lessonsBlock: lessonsRender.text,
        lessonsTruncated: lessonsRender.truncated,
        currentPlan,
        contextToolsAvailable: true
      });
    }
  }

  /**
   * Resolve the virtual content provider used to back the LEFT (snapshot) side
   * of a rollback-preview diff. Registered lazily on first use and disposed
   * with the provider. The returned scheme serves whatever string we stash in
   * `rollbackSnapshots` for a given URI.
   */
  private ensureRollbackSnapshotProvider(): Map<string, string> {
    if (!this.rollbackSnapshots) {
      this.rollbackSnapshots = new Map<string, string>();
      this.rollbackSnapshotSub = vscode.workspace.registerTextDocumentContentProvider(
        ROLLBACK_SNAPSHOT_SCHEME,
        {
          provideTextDocumentContent: (uri) => this.rollbackSnapshots?.get(uri.toString()) ?? ''
        }
      );
      this.context.subscriptions.push(this.rollbackSnapshotSub);
    }
    return this.rollbackSnapshots;
  }

  /**
   * Open a diff for one file that a rollback would change: LEFT = the file's
   * content as captured in the checkpoint (pre-prompt), RIGHT = the current
   * file on disk. When the file is NOT in the checkpoint it was created after
   * the prompt and will be DELETED by rollback — we show an empty LEFT side so
   * the diff reads as an all-deletions ("will be removed") preview.
   */
  private async openRollbackFileDiff(ref: string, relativePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const snapshot = await this.gitCheckpoint.getCheckpointFileSnapshot(ref, relativePath);
    const willDelete = snapshot === null;
    const snapshots = this.ensureRollbackSnapshotProvider();
    const fileUri = vscode.Uri.file(path.join(root, relativePath));
    const leftUri = fileUri.with({
      scheme: ROLLBACK_SNAPSHOT_SCHEME,
      path: fileUri.path + '.checkpoint'
    });
    snapshots.set(leftUri.toString(), snapshot ?? '');
    const title = willDelete
      ? `Rollback • ${path.basename(relativePath)} (will be deleted)`
      : `Rollback • ${path.basename(relativePath)} (Before prompt ↔ Current)`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, fileUri, title, {
      preview: true
    });
  }

  /**
   * Interactive rollback confirmation. Presents the affected files in a
   * QuickPick; each row has an "open diff" button so the user can inspect the
   * exact change a rollback would make before committing. Accepting the
   * "Roll Back" action resolves true; dismissing resolves false.
   */
  private async confirmRollbackWithDiffs(ref: string, affected: string[]): Promise<boolean> {
    type RbItem = vscode.QuickPickItem & { rbKind: 'action' | 'file'; file?: string };
    const diffButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('diff'),
      tooltip: 'Open diff (before prompt ↔ current)'
    };
    const items: Array<RbItem | vscode.QuickPickItem> = [
      {
        rbKind: 'action',
        label: '$(discard) Roll Back',
        detail: `Revert ${affected.length} file(s) to the state right before this prompt and truncate the chat. Your current working tree is saved as a safety checkpoint first.`,
        alwaysShow: true
      } as RbItem,
      {
        label: `${affected.length} file(s) will change — click the diff icon to preview`,
        kind: vscode.QuickPickItemKind.Separator
      }
    ];
    for (const f of affected) {
      items.push({
        rbKind: 'file',
        file: f,
        label: `$(file) ${f}`,
        buttons: [diffButton]
      } as RbItem);
    }

    return await new Promise<boolean>((resolve) => {
      const qp = vscode.window.createQuickPick<RbItem>();
      qp.title = 'Roll back to before this prompt?';
      qp.placeholder = 'Select “Roll Back” to confirm, or click a file’s diff icon to preview — press Esc to cancel';
      qp.ignoreFocusOut = true;
      qp.items = items as RbItem[];
      let done = false;
      const finish = (result: boolean): void => {
        if (done) return;
        done = true;
        qp.hide();
        qp.dispose();
        resolve(result);
      };
      qp.onDidTriggerItemButton((e) => {
        if (e.item.rbKind === 'file' && e.item.file) {
          void this.openRollbackFileDiff(ref, e.item.file);
        }
      });
      qp.onDidAccept(() => {
        const sel = qp.selectedItems[0];
        if (sel?.rbKind === 'action') {
          finish(true);
        } else if (sel?.rbKind === 'file' && sel.file) {
          // Selecting a file row (Enter) opens its diff but keeps the picker.
          void this.openRollbackFileDiff(ref, sel.file);
        }
      });
      qp.onDidHide(() => finish(false));
      qp.show();
    });
  }

  /**
   * Restore the working tree to the snapshot captured before a previous user
   * prompt was processed. Also truncates the session transcript back to that
   * point so the chat history stays consistent with the code on disk.
   *
   * `ref` may be empty when no git checkpoint was captured for this prompt
   * (auto-checkpoint disabled, not a git repo, runtime failure, or an old
   * session persisted before checkpointing existed). In that case we fall
   * back to chat-only truncation behind an explicit confirmation so the
   * user understands that the code state is NOT being restored.
   */
  private async rollbackToCheckpoint(ref: string, messageIndex: number): Promise<void> {
    if (!this.currentSession || !Number.isFinite(messageIndex) || messageIndex < 0) {
      vscode.window.showWarningMessage('BurstCode: nothing to roll back to.');
      return;
    }
    if (this.currentRun()) {
      vscode.window.showWarningMessage('BurstCode: stop the current request before rolling back.');
      return;
    }
    // Only the edits created AT or AFTER the turn we're rolling back to get
    // discarded — the git restore below reverts those files on disk anyway, so
    // keeping them in the banner would point at content that no longer exists.
    // Pending edits from EARLIER turns are left untouched: the user may still
    // be reviewing them and the restore-to-this-checkpoint preserves their
    // on-disk state.
    const pendingFromHere = this.applier.pendingHunksFrom(messageIndex, this.currentSession.id);
    if (pendingFromHere > 0) {
      const choice = await vscode.window.showWarningMessage(
        'BurstCode: there are still pending edits from this prompt onward. Discard them and roll back?',
        { modal: true },
        'Discard & Roll Back'
      );
      if (choice !== 'Discard & Roll Back') return;
      await this.applier.rejectAllFrom(messageIndex, this.currentSession.id);
    }

    // Show the overlay immediately so the user sees feedback while we verify
    // the checkpoint ref and scan affected files (both involve disk I/O).
    this.post({ type: 'rollback-start' });

    try {
      // Re-verify the ref still resolves before claiming we can restore disk
      // state. `git gc` / `git reflog expire` / a manual `update-ref -d` could
      // have clobbered the ref between when we wrote it and when the user
      // clicks rollback (e.g. across a long-lived VS Code session). Failing
      // verification here downgrades the action to chat-only truncation
      // BEFORE the modal so the user is asked the right question.
      let hasCheckpoint = !!ref;
      if (hasCheckpoint && !(await this.gitCheckpoint.refExists(ref))) {
        this.logger.warn('Rollback ref no longer exists — downgrading to chat-only', { ref });
        hasCheckpoint = false;
      }

      let confirmed = false;

      // Build a preview of the files that will actually revert so the user can
      // see the blast radius before confirming — and let them click into each
      // file's diff (checkpoint snapshot ↔ current) before deciding.
      if (hasCheckpoint) {
        const affected = await this.gitCheckpoint.listAffectedFiles(ref);
        if (affected.length > 0) {
          confirmed = await this.confirmRollbackWithDiffs(ref, affected);
        } else {
          const choice = await vscode.window.showWarningMessage(
            'Roll back the working tree to the state right before this prompt? Conversation after this point will also be removed. Your current working tree will first be saved as a safety checkpoint.' +
              '\n\nNo file changes detected since this prompt — only the chat history will be truncated.',
            { modal: true },
            'Roll Back'
          );
          confirmed = choice === 'Roll Back';
        }
      } else {
        const choice = await vscode.window.showWarningMessage(
          'No checkpoint was captured for this prompt, so the code on disk CANNOT be restored. Only the chat history will be truncated back to this point. Continue?',
          { modal: true },
          'Truncate Chat Only'
        );
        confirmed = choice === 'Truncate Chat Only';
      }
      if (!confirmed) {
        return;
      }
      if (hasCheckpoint) {
        const ok = await this.gitCheckpoint.restoreCheckpoint(ref);
        if (!ok) {
          return;
        }
      }

      const session = this.currentSession;
      // Capture the text of the user message we're rolling back BEFORE we
      // slice it out, so we can pre-fill the composer with it (Cursor-style
      // edit-and-resend). The message at `messageIndex` is guaranteed to be
      // a user message because that's the only kind that exposes a rollback
      // button in the webview.
      const rolledBackMsg = session.messages[messageIndex];
      const prefillText =
        rolledBackMsg && rolledBackMsg.role === 'user' && typeof rolledBackMsg.content === 'string'
          ? rolledBackMsg.content
          : '';

      session.messages = session.messages.slice(0, messageIndex);
      session.checkpoints = (session.checkpoints ?? []).filter(
        (c) => (!ref || c.ref !== ref) && c.messageIndex < messageIndex
      );
      session.plan = [];
      await this.persistCurrentSession();

      // Rebuild the chat panel from the trimmed transcript.
      this.post({ type: 'reset' });
      this.post({
        type: 'load-session',
        payload: {
          id: session.id,
          title: session.title,
          transcript: buildTranscript(session.messages, session.checkpoints),
          plan: session.plan ?? []
        }
      });
      // Drop the rolled-back prompt back into the composer so the user can
      // tweak it and resend instead of retyping the whole thing.
      if (prefillText) {
        this.post({ type: 'prefill-composer', payload: { text: prefillText } });
      }
      vscode.window.showInformationMessage(
        hasCheckpoint
          ? 'BurstCode: rolled back code & chat to the previous prompt.'
          : 'BurstCode: chat history truncated. Code on disk was NOT restored — no checkpoint was available.'
      );
    } finally {
      // Always clear the overlay, on every exit path (cancel, failed restore,
      // success, or an unexpected throw). The outer handleMessage().catch()
      // does NOT post rollback-end, so without this the overlay could stick
      // forever now that we show it BEFORE the disk I/O. Posting it after a
      // successful reset is harmless (idempotent — it just hides the overlay).
      this.post({ type: 'rollback-end' });
    }
  }

  private async runAgent(userText: string): Promise<void> {
    if (!userText.trim()) return;
    // Only block when THIS session is already running. Other sessions can
    // run concurrently in the background.
    const session = this.ensureSessionForUserText(userText);
    if (this.runs.has(session.id)) {
      vscode.window.showWarningMessage('BurstCode: this session already has a request running.');
      return;
    }

    this.foregroundActivityEmitter.fire('chat-start');

    // Allocate (and publish) the cancellation source FIRST, before any of
    // the slow setup work below. Otherwise a user clicking Stop while we are
    // still building the system prompt or creating the git checkpoint would
    // miss the in-flight setup phase.
    const cts = new vscode.CancellationTokenSource();
    const ctx: RunContext = {
      sessionId: session.id,
      session,
      cts,
      live: emptyLive()
    };
    this.runs.set(session.id, ctx);
    session.status = 'running';
    this.broadcastSessions();

    // Capture which session this run targets — this stays fixed for the
    // entire run even if the user switches the foreground view away.
    const isActive = (): boolean => this.currentSession?.id === session.id;
    const postLive = (msg: OutboundMessage): void => {
      if (isActive()) this.post(msg);
    };

    this.ensureSystemMessageSlot(session);
    const messageIndex = session.messages.length;
    session.messages.push({ role: 'user', content: userText });
    // Tag any edits this run queues with the turn that produced them, so a
    // later rollback to an EARLIER turn only discards this turn's edits and
    // leaves still-unreviewed edits from previous turns in the banner.
    this.applier.setCurrentTurn(messageIndex);
    // Tag this run's edits with the owning session so the banner / accept /
    // reject stay scoped to this tab when the user switches between sessions.
    this.applier.setCurrentSession(session.id);

    // Kick off the two slow setup tasks in PARALLEL: creating a git
    // checkpoint (spawns `git`, can be hundreds of ms on big repos) and
    // building the workspace-outline-augmented system prompt (filesystem
    // walk, also hundreds of ms). They are independent so we don't pay for
    // them serially before the LLM stream starts.
    //
    // `createCheckpoint` now THROWS on failure with a descriptive message
    // (was: silently returned undefined). We surface that message through
    // to the rollback button's title so a broken checkpoint state is
    // diagnosable from the chat panel itself rather than requiring the user
    // to open the BurstCode output channel.
    //
    // IMPORTANT: Send the user message to the UI immediately to prevent blocking.
    // The checkpoint is created in the background without waiting for it.
    postLive({
      type: 'user-message',
      payload: { text: userText, messageIndex, checkpointRef: undefined, checkpointError: undefined }
    });

    // Create checkpoint in background - don't block the UI
    void (async () => {
      try {
        const info = await this.gitCheckpoint.createCheckpoint(`prompt: ${deriveTitle(userText)}`);
        const entry: SessionCheckpoint = {
          messageIndex,
          ref: info.ref,
          sha: info.sha,
          createdAt: info.createdAt,
          label: info.label
        };
        session.checkpoints = [...(session.checkpoints ?? []), entry];
        // Update the webview rollback button with the actual ref now that
        // checkpoint creation completed. Without this, the button renders with
        // checkpointRef=undefined (sent immediately before the async create)
        // and the click handler would always send an empty ref.
        postLive({ type: 'update-checkpoint-ref', payload: { messageIndex, ref: info.ref } });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn('Failed to create per-prompt checkpoint', message);
        // One-shot popup the very first time per extension session so the user
        // notices a broken setup right away. Subsequent failures only re-log;
        // the rollback button's tooltip already shows the reason inline.
        if (!this.checkpointFailureNotified) {
          this.checkpointFailureNotified = true;
          void vscode.window.showWarningMessage(
            `BurstCode: rollback unavailable — checkpoint failed (${message}). See BurstCode output for details.`
          );
        }
      }
    })();

    const systemPromptPromise = this.buildSystemPromptForRun(userText);
    if (isActive()) this.broadcastContextUsage();
    void this.persistSession(session);

    const llmCfg = readLLMConfig();
    const client = new OpenAIClient(llmCfg, this.logger);
    const bridge = new LspBridge(
      vscode.workspace.getConfiguration('burstcode.lsp').get<number>('maxWaitMs') ?? 60000
    );

    const askUser = (spec: AskUserSpec): Promise<string> => {
      return new Promise<string>((resolve) => {
        const id = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const askSpec: PendingAskSnap = {
          id,
          question: spec.question,
          inputType: spec.inputType,
          options: spec.options,
          allowCustomText: !!spec.allowCustomText,
          placeholder: spec.placeholder
        };
        ctx.pendingAsk = { resolve, id, spec: askSpec };
        ctx.live.pendingAsk = askSpec;
        postLive({
          type: 'ask-user',
          payload: { sessionId: session.id, ...askSpec }
        });
        // If the run is cancelled before the user answers, unblock the agent
        // loop so it can wind down cleanly instead of hanging on this promise.
        const cancelSub = cts.token.onCancellationRequested(() => {
          if (ctx.pendingAsk?.id === id) {
            ctx.pendingAsk = undefined;
            ctx.live.pendingAsk = undefined;
            postLive({ type: 'ask-user-cancel', payload: { id } });
            resolve('(cancelled by user)');
          }
          cancelSub.dispose();
        });
      });
    };

    const onPlanUpdate = (steps: PlanStep[]): void => {
      // Plan belongs to the run's session, not necessarily the visible one.
      session.plan = steps;
      postLive({ type: 'plan-update', payload: { steps } });
      void this.persistSession(session);
    };

    // Send run-start immediately to update UI before awaiting system prompt
    postLive({ type: 'run-start' });

    const systemPrompt = await systemPromptPromise;
    const agentCfg = vscode.workspace.getConfiguration('burstcode.agent');
    const coreReadTools: Tool[] = [buildCollectContextTool(this.applier), buildReadFileTool(this.applier), listDirTool, grepSearchTool, workspaceOutlineTool, webSearchTool, readWebpageTool];
    const writeFileTool = buildWriteFileTool();
    const lspTools = buildLspTools(bridge, this.depGuard);
    const editTools = buildEditTools(this.applier, askUser);
    const subagentTool = buildSubagentTool({
      clientFactory: () => new OpenAIClient(llmCfg, this.logger),
      logger: this.logger,
      applier: this.applier,
      readTools: [...coreReadTools, ...lspTools],
      writeTools: editTools.filter((t) => t.name === 'propose_edit'),
      systemPrompt,
      contextWindow: llmCfg.contextWindow,
      maxIterations: agentCfg.get<number>('subagentMaxIterations') ?? 8,
      maxConcurrent: Math.max(1, agentCfg.get<number>('maxConcurrentSubagents') ?? 4),
      maxTasksPerCall: Math.max(1, agentCfg.get<number>('maxSubagentTasksPerCall') ?? 8),
      enableWrites: agentCfg.get<boolean>('enableWriteSubagents') ?? true
    });

    const tools: Tool[] = [
      ...coreReadTools,
      ...lspTools,
      subagentTool,
      ...buildLangTools(),
      ...editTools,
      writeFileTool,
      buildImageTool(this.logger),
      ...buildShellTools({ askUser }),
      buildPlanTool(onPlanUpdate),
      ...buildLessonTools(this.lessons, (list) => {
        // Lessons are read into the system prompt at run START. Mid-run
        // mutations (record_lesson / forget_lesson) won't change the system
        // message for the current turn — the next run will pick them up. We
        // still broadcast immediately so the side panel reflects reality
        // while the agent is working.
        this.logger.info(`Lessons store updated; ${list.length} entries.`);
        this.broadcastLessons();
      })
    ];

    const agent = new AgentLoop(client, tools, this.applier, this.logger, {
      contextWindow: llmCfg.contextWindow,
      maxIterations: agentCfg.get<number>('maxIterations') ?? 512,
      requireConfirmBeforeEdit: agentCfg.get<boolean>('requireConfirmBeforeEdit') ?? true,
      autoContinueOnLength: agentCfg.get<boolean>('autoContinueOnLength') ?? true,
      maxAutoContinues: agentCfg.get<number>('maxAutoContinues') ?? 3,
      autoResumeOnStreamError: agentCfg.get<boolean>('autoResumeOnStreamError') ?? true,
      maxAutoResumes: agentCfg.get<number>('maxAutoResumes') ?? 3,
      maxStuckRepeats: agentCfg.get<number>('maxStuckRepeats') ?? 2,
      autoContinueOnPrematureStop: agentCfg.get<boolean>('autoContinueOnPrematureStop') ?? true,
      maxPrematureStopContinues: agentCfg.get<number>('maxPrematureStopContinues') ?? 2,
      askUser,
      systemPrompt
    });

    let doneReason: string | undefined;
    let sawError = false;
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const runTools = workspaceRoot
        ? buildContextTools(
            session.messages,
            workspaceRoot,
            llmCfg.contextWindow,
            (info) => {
              session.checkpoints = [];
              // Sync the UI context gauge with the post-compression token count
              // (reuse the same event the auto-compressor emits, so the webview
              // updates the bar and flashes a notice).
              postLive({
                type: 'context-compressed',
                payload: { before: info.before, after: info.after, max: info.max }
              });
            }
          )
        : [];
      for await (const event of agent.run(session.messages, cts.token, runTools)) {
        // Update the per-session live snapshot FIRST so it stays consistent
        // whether or not the webview is currently showing this session.
        this.applyEventToLive(ctx, event);
        switch (event.type) {
          case 'assistant-delta':
            postLive({ type: 'assistant-delta', payload: { text: event.payload as string } });
            break;
          case 'reasoning-delta':
            postLive({ type: 'reasoning-delta', payload: { text: event.payload as string } });
            break;
          case 'assistant-message':
            postLive({ type: 'assistant-message', payload: event.payload });
            break;
          case 'tool-call-start':
            postLive({ type: 'tool-call-start', payload: event.payload });
            break;
          case 'tool-call-end':
            postLive({ type: 'tool-call-end', payload: event.payload });
            break;
          case 'tool-call-args-delta':
            postLive({ type: 'tool-call-args-delta', payload: event.payload });
            break;
          case 'tool-progress':
            postLive({ type: 'tool-progress', payload: event.payload });
            break;
          case 'iteration-start':
            postLive({ type: 'iteration', payload: event.payload });
            break;
          case 'auto-continue':
            postLive({ type: 'auto-continue', payload: event.payload });
            break;
          case 'auto-resume':
            postLive({ type: 'auto-resume', payload: event.payload });
            break;
          case 'context-usage':
            postLive({ type: 'context-usage', payload: event.payload });
            break;
          case 'context-compressed':
            postLive({ type: 'context-compressed', payload: event.payload });
            break;
          case 'stuck-detected':
            postLive({ type: 'stuck-detected', payload: event.payload });
            break;
          case 'error':
            sawError = true;
            postLive({ type: 'error', payload: event.payload });
            break;
          case 'done': {
            const r = (event.payload as { reason?: string } | undefined)?.reason;
            doneReason = typeof r === 'string' ? r : undefined;
            postLive({ type: 'done', payload: event.payload });
            break;
          }
        }
      }
    } catch (err) {
      sawError = true;
      this.logger.error('Agent run failed', String(err));
      postLive({ type: 'error', payload: String(err) });
    } finally {
      this.runs.delete(session.id);
      cts.dispose();
      // Decide final status: error > cancelled > completed.
      const cancelled = cts.token.isCancellationRequested || doneReason === 'cancelled';
      session.status = sawError
        ? 'error'
        : cancelled
          ? 'stopped'
          : doneReason === 'max_iterations' || doneReason === 'stuck' || doneReason === 'aborted-stuck'
            ? 'stopped'
            : 'completed';
      this.foregroundActivityEmitter.fire('chat-end');
      if (isActive()) this.broadcastContextUsage();
      await this.persistSession(session);
      this.broadcastSessions();
    }
  }

  /** Mutate the per-session live snapshot in response to one agent event. */
  private applyEventToLive(ctx: RunContext, event: { type: string; payload?: unknown }): void {
    const live = ctx.live;
    switch (event.type) {
      case 'assistant-delta':
        live.assistantText += String(event.payload ?? '');
        live.lastStatus = { state: 'busy', label: live.iter ? `Streaming (iter ${live.iter})...` : 'Streaming...' };
        break;
      case 'reasoning-delta':
        live.reasoningText += String(event.payload ?? '');
        break;
      case 'assistant-message': {
        // Preserve the just-finalized segment so a mid-run replay can rebuild
        // it. The agent loop emits this right before auto-continuing after a
        // finish_reason=length truncation; resetting assistantText to '' (as
        // before) silently discarded every segment but the last.
        const finalText = String((event.payload as { text?: unknown } | undefined)?.text ?? '');
        if (finalText.trim().length > 0) {
          live.finalizedAssistantTexts.push(finalText);
        }
        live.assistantText = '';
        live.reasoningText = '';
        break;
      }
      case 'tool-call-start': {
        const p = (event.payload ?? {}) as { id?: string; name?: string; args?: unknown; streaming?: boolean };
        const id = String(p.id ?? `${p.name}_${Date.now()}`);
        this.logger.info(`[applyEventToLive] tool-call-start event received. name=${p.name}, id=${id}, streaming=${!!p.streaming}, args=${JSON.stringify(p.args)}`);
        live.runningTools.set(id, { id, name: String(p.name ?? ''), args: p.args, startedAt: Date.now() });
        const names = Array.from(live.runningTools.values()).map((t) => t.name).join(', ');
        live.lastStatus = { state: 'tool', label: `Running ${names}...` };
        break;
      }
      case 'tool-call-end': {
        const p = (event.payload ?? {}) as { id?: string; name?: string; result?: string; isError?: boolean };
        this.logger.info(`[applyEventToLive] tool-call-end event received. name=${p.name}, id=${p.id}, isError=${!!p.isError}`);
        if (p.id) {
          live.runningTools.delete(p.id);
          live.toolProgress.delete(p.id);
        }
        live.lastStatus = live.runningTools.size === 0
          ? { state: 'busy', label: live.iter ? `Thinking (iter ${live.iter})...` : 'Thinking...' }
          : { state: 'tool', label: `Running ${Array.from(live.runningTools.values()).map((t) => t.name).join(', ')}...` };
        break;
      }
      case 'tool-progress': {
        const p = (event.payload ?? {}) as { id?: string; message?: string };
        if (p.id) {
          const arr = live.toolProgress.get(p.id) ?? [];
          arr.push(String(p.message ?? ''));
          // Cap to keep memory bounded.
          if (arr.length > 200) arr.splice(0, arr.length - 200);
          live.toolProgress.set(p.id, arr);
        }
        break;
      }
      case 'iteration-start': {
        const p = (event.payload ?? {}) as { iter?: number };
        const iter = Number(p.iter ?? 0) + 1;
        live.iter = iter;
        live.pills.push({ kind: 'iteration', payload: { iter: iter - 1 } });
        live.assistantText = '';
        live.reasoningText = '';
        // A new iteration's finalized segments are already committed to the
        // persistent transcript (session.messages), so the per-iteration
        // buffer can reset to avoid double-rendering on replay.
        live.finalizedAssistantTexts = [];
        live.lastStatus = { state: 'busy', label: `Thinking (iter ${iter})...` };
        break;
      }
      case 'auto-continue':
        live.pills.push({ kind: 'auto-continue', payload: event.payload });
        break;
      case 'auto-resume':
        live.pills.push({ kind: 'auto-resume', payload: event.payload });
        live.assistantText = '';
        live.reasoningText = '';
        break;
      case 'done':
        live.lastStatus = { state: 'done', label: 'Done' };
        live.runningTools.clear();
        live.toolProgress.clear();
        break;
      case 'error':
        live.lastStatus = { state: 'error', label: 'Error' };
        break;
    }
  }

  /** Persist a specific session (not necessarily the currently-visible one). */
  private async persistSession(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    try {
      await this.sessions.save(session);
    } catch (err) {
      this.logger.error('Failed to persist session', String(err));
    }
    this.broadcastSessions();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join('; ');
    const diagEnabled = vscode.workspace.getConfiguration('burstcode.diag').get<boolean>('webviewProbe', false);
    const diagBannerHtml = diagEnabled
      ? `<div id="bcDiagBanner" style="position:fixed;left:0;right:0;bottom:0;background:rgba(122,31,31,0.92);color:#fff;font:11px/1.4 ui-monospace,monospace;padding:6px 28px 6px 8px;z-index:99999;white-space:pre-wrap;max-height:40vh;overflow:auto;box-shadow:0 -2px 8px rgba(0,0,0,0.5);pointer-events:none;user-select:text;">[BurstCode probe] script has NOT executed yet — if you see this for more than 1s the inline &lt;script&gt; tag failed to run (CSP / nonce / syntax). Open DevTools (right-click → Inspect) for the exact reason.</div>`
      : '';
    const diagScript = diagEnabled
      ? `
window.addEventListener('error', (ev) => {
  console.error('[BurstCode][webview-error]', ev.message, ev.filename + ':' + ev.lineno + ':' + ev.colno, ev.error);
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('[BurstCode][webview-rejection]', ev.reason);
});
function describeNode(n) {
  if (!n || !n.tagName) return String(n);
  const cls = typeof n.className === 'string'
    ? n.className
    : (n.className && n.className.baseVal) || '';
  const tail = cls ? '.' + String(cls).split(' ').filter(Boolean).join('.') : '';
  return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + tail;
}
document.addEventListener('click', (ev) => {
  try {
    console.log('[BurstCode][click]', describeNode(ev.target), 'x=' + ev.clientX, 'y=' + ev.clientY);
  } catch (e) {}
}, true);
function runProbe() {
  const ids = ['tabs', 'newBtn', 'historyBtn', 'lessonsBtn', 'cfgBtn', 'modelPickerBtn', 'sendBtn', 'bgStatus', 'input'];
  const lines = [];
  for (const id of ids) {
    try {
      const el = document.getElementById(id);
      if (!el) { lines.push(id + ': MISSING'); continue; }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const overlaid = hit !== el && !el.contains(hit);
      const line = id + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + '] -> ' + describeNode(hit) + (overlaid ? ' !! BLOCKED' : ' ok');
      console.log('[BurstCode][probe]', line);
      lines.push(line);
    } catch (err) {
      lines.push(id + ': ERR ' + err);
    }
  }
  return lines;
}
function showDiagBanner(lines) {
  const banner = document.getElementById('bcDiagBanner');
  if (!banner) return;
  banner.textContent = '[BurstCode probe @ ' + new Date().toLocaleTimeString() + ']\\n' + lines.join('\\n');
}
showDiagBanner(['probing...']);
try { showDiagBanner(runProbe()); } catch (err) { showDiagBanner(['probe-err: ' + err]); }
setTimeout(() => {
  try { showDiagBanner(runProbe()); } catch (err) { showDiagBanner(['probe-err(late): ' + err]); }
}, 600);
`
      : '';

    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: var(--vscode-color-scheme); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; position: relative; }

  /* ============ Top bar (single row: tabs + action icons) ============ */
  /*
   * Single-row topbar: tab strip on the left grows to fill, action icon
   * buttons (history / lessons / settings) sit on the right. No brand label
   * \u2014 the tabs themselves identify the current chat. Tabs dock to the
   * bottom hairline of the topbar so they read as proper "tabs" (rounded
   * top, flush bottom merging with the chat area below).
   */
  .topbar { display: flex; align-items: stretch; gap: 2px; padding: 6px 8px 0; background: var(--vscode-sideBar-background); flex-shrink: 0; position: relative; min-height: 36px; }
  .topbar::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: var(--vscode-panel-border); opacity: 0.5; }
  .topbar .icon-btn { background: transparent; color: var(--vscode-foreground); border: none; border-radius: 5px; padding: 4px; cursor: pointer; opacity: 0.65; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; transition: opacity 0.15s, background 0.15s; align-self: center; flex-shrink: 0; margin-bottom: 4px; }
  .topbar .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .topbar .icon-btn svg { width: 15px; height: 15px; }
  .topbar .divider { width: 1px; height: 16px; background: var(--vscode-panel-border); opacity: 0.5; margin: 0 4px; align-self: center; }

  /* ============ Session tabs (inline with topbar) ============ */
  /*
   * Tab strip lives INSIDE the topbar so the layout is one compact row.
   * Each tab is a rounded-top rectangle whose fill is a vertical gradient
   * \u2014 darker at the BOTTOM, fading toward near-transparent at the TOP. The
   * base tint comes from --tab-color (per status: running / done / stopped
   * / error / idle). The active tab uses a stronger ramp and a 2px overlay
   * that covers the topbar's bottom hairline so it visually merges with the
   * chat area below.
   */
  #tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; align-items: flex-end; padding-right: 4px; }
  #tabs::-webkit-scrollbar { height: 6px; }
  #tabs::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
  #tabs::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
  .tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px 6px 10px; font-size: 0.78em; line-height: 1.3; border: 1px solid var(--vscode-panel-border); border-bottom: none; border-radius: 6px 6px 0 0; cursor: pointer; max-width: 160px; min-width: 70px; color: var(--vscode-foreground); position: relative; flex-shrink: 0; user-select: none; transition: opacity 0.15s, transform 0.15s; opacity: 0.72; --tab-color: var(--vscode-descriptionForeground); background: linear-gradient(to top, color-mix(in srgb, var(--tab-color) 32%, var(--vscode-sideBar-background)) 0%, color-mix(in srgb, var(--tab-color) 6%, var(--vscode-sideBar-background)) 100%); }
  .tab:hover { opacity: 0.95; }
  /* Active tab: stronger ramp + a 2px strip overlapping the topbar bottom
     hairline so the tab visually "connects" to the chat area below. */
  .tab[data-active="true"] { opacity: 1; border-color: color-mix(in srgb, var(--tab-color) 55%, var(--vscode-panel-border)); background: linear-gradient(to top, color-mix(in srgb, var(--tab-color) 55%, var(--vscode-sideBar-background)) 0%, color-mix(in srgb, var(--tab-color) 18%, var(--vscode-sideBar-background)) 100%); z-index: 1; }
  .tab[data-active="true"]::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--vscode-sideBar-background); }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tab-color); flex-shrink: 0; box-shadow: 0 0 4px color-mix(in srgb, var(--tab-color) 55%, transparent); }
  .tab[data-state="running"] .dot { animation: tabPulse 1.1s ease-in-out infinite; }
  .tab .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .tab .close { background: transparent; border: none; color: inherit; opacity: 0; padding: 1px 4px; cursor: pointer; border-radius: 3px; font-size: 11px; line-height: 1; flex-shrink: 0; transition: opacity 0.15s, background 0.15s; }
  .tab:hover .close, .tab[data-active="true"] .close { opacity: 0.55; }
  .tab .close:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  .tab[data-state="running"] { --tab-color: var(--vscode-charts-blue); }
  .tab[data-state="completed"] { --tab-color: var(--vscode-charts-green); }
  .tab[data-state="stopped"] { --tab-color: var(--vscode-charts-orange, #d18616); }
  .tab[data-state="error"] { --tab-color: var(--vscode-errorForeground); }
  .tab[data-state="idle"] { --tab-color: var(--vscode-descriptionForeground); }
  @keyframes tabPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.65); } }

  /* Right-click context menu for tabs. Floats over everything, dismissed on
     outside click / Escape. Layout mimics VS Code's native menu popups. */
  .tab-menu { position: fixed; z-index: 1000; min-width: 168px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border)); border-radius: 6px; padding: 4px 0; box-shadow: 0 6px 20px rgba(0,0,0,0.45); font-size: 0.84em; user-select: none; }
  .tab-menu .item { padding: 5px 14px; cursor: pointer; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .tab-menu .item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
  .tab-menu .item.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground) 22%, transparent); color: var(--vscode-errorForeground); }
  .tab-menu .item.disabled { opacity: 0.4; cursor: default; pointer-events: none; }
  .tab-menu .sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; opacity: 0.7; }

  /* ============ Model picker pill (above composer) ============ */
  .model-bar { display: flex; align-items: center; gap: 6px; padding: 0 4px 6px; }

  /* Context-usage gauge sits on the right of the model picker. */
  #ctxUsage { display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px; border-radius: 6px; border: 1px solid transparent; cursor: default; font-size: 0.78em; opacity: 0.8; font-variant-numeric: tabular-nums; user-select: none; transition: opacity 0.15s, background 0.15s, border-color 0.15s; }
  #ctxUsage:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #ctxUsage .ring { width: 14px; height: 14px; flex-shrink: 0; }
  #ctxUsage .ring .bg { fill: none; stroke: var(--vscode-panel-border); stroke-width: 3; opacity: 0.55; }
  #ctxUsage .ring .fg { fill: none; stroke: var(--vscode-charts-green); stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset 0.3s ease, stroke 0.2s; }
  #ctxUsage[data-level="warn"] .ring .fg { stroke: var(--vscode-charts-yellow); }
  #ctxUsage[data-level="crit"] .ring .fg { stroke: var(--vscode-charts-red); }
  #ctxUsage[data-level="warn"] { opacity: 0.95; }
  #ctxUsage[data-level="crit"] { opacity: 1; color: var(--vscode-errorForeground); }
  #ctxUsage .pct { opacity: 0.85; }
  #ctxUsage .tokens { opacity: 0.55; font-size: 0.95em; }
  @keyframes ctxFlash { 0% { background: var(--vscode-charts-blue); opacity: 0.35; } 100% { background: transparent; opacity: 0.8; } }
  #ctxUsage.flash { animation: ctxFlash 1.4s ease-out; }

  /* Background explorer pill — sits inline at the right end of the composer hint row. */
  #bgStatus { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; font-size: 1em; opacity: 0.85; user-select: none; transition: opacity 0.15s, background 0.15s, border-color 0.15s; max-width: 180px; }
  #bgStatus:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #bgStatus .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex-shrink: 0; }
  #bgStatus .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  #bgStatus[data-phase="idle-waiting"] .dot { background: var(--vscode-charts-green); }
  #bgStatus[data-phase="running"] .dot { background: var(--vscode-charts-yellow); animation: bgPulse 1.1s ease-in-out infinite; }
  #bgStatus[data-phase="paused-by-chat"] .dot,
  #bgStatus[data-phase="paused-by-activity"] .dot { background: var(--vscode-charts-orange, #d18616); }
  #bgStatus[data-phase="error"] .dot { background: var(--vscode-charts-red); }
  #bgStatus[data-phase="error"] { color: var(--vscode-errorForeground); }
  #bgStatus[data-phase="disabled"], #bgStatus[data-phase="no-workspace"] { opacity: 0.5; }
  @keyframes bgPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.85); } }
  #modelPickerBtn { display: inline-flex; align-items: center; gap: 6px; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 6px; padding: 3px 8px 3px 6px; font-size: 0.8em; opacity: 0.7; cursor: pointer; max-width: 100%; transition: opacity 0.15s, background 0.15s, border-color 0.15s; }
  #modelPickerBtn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #modelPickerBtn[aria-expanded="true"] { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #modelPickerBtn .icon { width: 12px; height: 12px; opacity: 0.75; flex-shrink: 0; }
  #modelPickerBtn .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
  #modelPickerBtn .label .ep { opacity: 0.65; }
  #modelPickerBtn .label .sep { opacity: 0.45; margin: 0 4px; }
  #modelPickerBtn .label .model { font-weight: 500; }
  #modelPickerBtn .chev { width: 10px; height: 10px; opacity: 0.6; flex-shrink: 0; }

  /* Popover anchored to the composer-wrap bottom; #composer-wrap is set to
     position:relative below so this opens upward immediately above the pill. */
  #modelPicker { position: absolute; bottom: calc(100% - 4px); left: 12px; right: 12px; max-height: 60vh; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; box-shadow: 0 -8px 24px rgba(0,0,0,0.35); z-index: 20; display: none; }
  #modelPicker.open { display: block; }
  #modelPicker .ep-group { border-bottom: 1px solid var(--vscode-panel-border); }
  #modelPicker .ep-group:last-child { border-bottom: none; }
  #modelPicker .ep-head { display: flex; align-items: center; padding: 8px 10px 4px; font-size: 0.78em; opacity: 0.75; gap: 6px; }
  #modelPicker .ep-head .name { font-weight: 600; flex-shrink: 0; }
  #modelPicker .ep-head .url { opacity: 0.55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  #modelPicker .ep-head .refresh { background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.6; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; }
  #modelPicker .ep-head .refresh:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  #modelPicker .ep-head .refresh[data-loading="true"] { opacity: 0.85; }
  #modelPicker .ep-head .refresh[data-loading="true"] .icon { animation: spin 0.9s linear infinite; }
  #modelPicker .ep-head .refresh .icon { width: 12px; height: 12px; }
  @keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  #modelPicker .ep-error { padding: 4px 12px 8px; color: var(--vscode-errorForeground); font-size: 0.78em; }
  #modelPicker .model-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px 5px 18px; cursor: pointer; font-size: 0.88em; }
  #modelPicker .model-row:hover { background: var(--vscode-list-hoverBackground); }
  #modelPicker .model-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #modelPicker .model-row .check { width: 12px; flex-shrink: 0; opacity: 0.85; }
  #modelPicker .model-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #modelPicker .model-row .badge { font-size: 0.75em; opacity: 0.55; flex-shrink: 0; }
  #modelPicker .model-row .del { background: transparent; border: none; color: var(--vscode-foreground); padding: 2px 5px; border-radius: 3px; opacity: 0; cursor: pointer; font-size: 0.95em; flex-shrink: 0; }
  #modelPicker .model-row:hover .del { opacity: 0.55; }
  #modelPicker .model-row .del:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  #modelPicker .empty-models { padding: 4px 18px 8px; opacity: 0.55; font-size: 0.8em; font-style: italic; }
  #modelPicker .add-row { display: flex; gap: 4px; padding: 4px 10px 8px 18px; }
  #modelPicker .add-row input { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 3px 6px; font-size: 0.85em; outline: none; }
  #modelPicker .add-row input:focus { border-color: var(--vscode-focusBorder); }
  #modelPicker .add-row button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 0.82em; }
  #modelPicker .add-row button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #modelPicker .footer { padding: 6px 12px; font-size: 0.78em; opacity: 0.7; border-top: 1px solid var(--vscode-panel-border); }
  #modelPicker .footer a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  #modelPicker .footer a:hover { text-decoration: underline; }

  /* ============ Status ============ */
  #status { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: transparent; font-size: 0.8em; min-height: 20px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
  #status[data-active="true"] { opacity: 1; }
  #status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex-shrink: 0; }
  #status .label { flex: 1; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status .elapsed { font-variant-numeric: tabular-nums; opacity: 0.55; font-size: 0.95em; }
  #status[data-state="busy"] .dot { background: var(--vscode-charts-blue); animation: pulse 1.1s ease-in-out infinite; }
  #status[data-state="tool"] .dot { background: var(--vscode-charts-yellow); animation: pulse 1.1s ease-in-out infinite; }
  #status[data-state="continue"] .dot { background: var(--vscode-charts-purple); animation: pulse 1.1s ease-in-out infinite; }
  #status[data-state="awaiting"] .dot { background: var(--vscode-charts-orange); }
  #status[data-state="done"] .dot { background: var(--vscode-charts-green); }
  #status[data-state="error"] .dot { background: var(--vscode-errorForeground); }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.7); } }

  /* ============ Plan ============ */
  /* Pinned above the chat log, collapsible so it never overwhelms the conversation. */
  #plan { display: none; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); flex-shrink: 0; }
  #plan.has-steps { display: block; }
  #plan .plan-title { display: flex; align-items: center; gap: 6px; padding: 6px 14px; font-weight: 600; opacity: 0.85; font-size: 0.85em; cursor: pointer; user-select: none; }
  #plan .plan-title:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  #plan .plan-title .chev { display: inline-block; width: 10px; flex-shrink: 0; opacity: 0.7; transition: transform 0.12s; }
  #plan.collapsed .plan-title .chev { transform: rotate(-90deg); }
  #plan .plan-title .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #plan .plan-body { padding: 0 14px 8px; max-height: 28vh; overflow-y: auto; }
  #plan.collapsed .plan-body { display: none; }
  #plan ol { margin: 0; padding-left: 4px; list-style: none; }
  #plan li { margin: 2px 0; line-height: 1.45; font-size: 0.9em; }
  #plan li.completed { opacity: 0.55; }
  #plan li.completed .text { text-decoration: line-through; }
  #plan li.in_progress { color: var(--vscode-charts-blue); font-weight: 600; }
  #plan li .icon { display: inline-block; width: 16px; text-align: center; opacity: 0.85; }

  /* ============ Conversation ============ */
  /* Note: no scroll-behavior:smooth so that auto-follow detection (which
     compares scrollTop against scrollHeight on every scroll event) is not
     fooled by intermediate frames of a smooth-scroll animation. */
  #log { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; overflow-anchor: none; padding: 16px 14px 60px; }
  #log .turn { margin-bottom: 18px; max-width: 100%; }
  #log .turn:last-child { margin-bottom: 8px; }

  /* User: subtle prefix block, like a quoted prompt */
  .msg.user { display: flex; gap: 8px; padding: 6px 10px; background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-textLink-foreground); border-radius: 0 4px 4px 0; line-height: 1.5; word-wrap: break-word; opacity: 0.95; position: relative; }
  .msg.user .gutter { color: var(--vscode-textLink-foreground); font-weight: 700; flex-shrink: 0; user-select: none; }
  .msg.user .body { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }
  .msg.user .rollback-btn { flex-shrink: 0; background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 0.78em; opacity: 0.55; transition: opacity 0.15s, background 0.15s, color 0.15s; display: inline-flex; align-items: center; gap: 3px; align-self: flex-start; }
  .msg.user:hover .rollback-btn { opacity: 0.9; }
  .msg.user .rollback-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .msg.user .rollback-btn svg { width: 11px; height: 11px; }

  /* Assistant: clean prose, no bubble. Rendered as Markdown. */
  .msg.assistant { padding: 2px 4px 2px 26px; line-height: 1.6; word-wrap: break-word; position: relative; }
  .msg.assistant::before { content: '⏺'; color: var(--vscode-charts-green); position: absolute; left: 6px; top: 2px; opacity: 0.85; }
  /* Bottom action bar — only revealed on hover. Modeled after ChatGPT/Claude. */
  .msg.assistant .msg-actions { display: flex; align-items: center; gap: 2px; margin-top: 6px; opacity: 0; transform: translateY(-2px); transition: opacity 0.18s ease, transform 0.18s ease; pointer-events: none; }
  .msg.assistant:hover .msg-actions,
  .msg.assistant:focus-within .msg-actions { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .msg.assistant .msg-actions .act { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 3px 8px; border-radius: 6px; font-size: 0.78em; font-family: inherit; line-height: 1; transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease; }
  .msg.assistant .msg-actions .act:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .msg.assistant .msg-actions .act:active { transform: scale(0.97); }
  .msg.assistant .msg-actions .act.copied { color: var(--vscode-charts-green, #2ea043); border-color: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 30%, transparent); background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 10%, transparent); }
  .msg.assistant .msg-actions .act svg { width: 12px; height: 12px; flex-shrink: 0; }
  .msg.assistant .msg-actions .sep { width: 1px; height: 11px; background: var(--vscode-panel-border); opacity: 0.6; margin: 0 2px; }
  /* Markdown content */
  .md > *:first-child { margin-top: 0; }
  .md > *:last-child { margin-bottom: 0; }
  .md p { margin: 0.5em 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 0.9em 0 0.4em; line-height: 1.3; font-weight: 600; }
  .md h1 { font-size: 1.35em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .md h2 { font-size: 1.2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; }
  .md h3 { font-size: 1.08em; }
  .md h4 { font-size: 1em; }
  .md h5, .md h6 { font-size: 0.95em; opacity: 0.85; }
  .md ul, .md ol { margin: 0.4em 0; padding-left: 1.6em; }
  .md ul { list-style: disc; }
  .md ol { list-style: decimal; }
  .md li { margin: 0.2em 0; }
  .md li > ul, .md li > ol { margin: 0.2em 0; }
  .md blockquote { margin: 0.5em 0; padding: 4px 12px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); opacity: 0.92; border-radius: 0 4px 4px 0; }
  .md blockquote > p { margin: 0.25em 0; }
  .md hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 1em 0; }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .md a:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }
  .md .file-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .md .file-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }
  .md .file-link code { border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 50%, var(--vscode-panel-border)); }
  .md pre .code-head .file-link { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 1em; opacity: 1; color: var(--vscode-textLink-foreground); }
  .md pre .code-head .file-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }
  .md .symbol-link { color: var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground)); text-decoration: none; cursor: pointer; }
  .md .symbol-link:hover { text-decoration: underline; }
  .md .symbol-link code { border-color: color-mix(in srgb, var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground)) 50%, var(--vscode-panel-border)); }
  .md code { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 0.92em; background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--vscode-panel-border); }
  .md pre { margin: 0.6em 0; padding: 0; border-radius: 6px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); overflow: hidden; }
  .md pre .code-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; font-family: var(--vscode-font-family); font-size: 0.74em; opacity: 0.7; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); user-select: none; }
  .md pre .code-head .lang { text-transform: lowercase; letter-spacing: 0.3px; }
  .md pre .code-head .copy { background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.7; cursor: pointer; font-size: 1em; padding: 2px 6px; border-radius: 3px; }
  .md pre .code-head .copy:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .md pre code { display: block; padding: 10px 12px; background: transparent; border: none; border-radius: 0; overflow-x: auto; white-space: pre; font-size: 0.9em; line-height: 1.5; }
  .md table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.92em; }
  .md table th, .md table td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; }
  .md table th { background: var(--vscode-editorWidget-background); }
  .md strong { font-weight: 600; }
  .md em { font-style: italic; }
  .md kbd { font-family: var(--vscode-editor-font-family); font-size: 0.85em; padding: 1px 5px; border-radius: 3px; background: var(--vscode-keybindingLabel-background, var(--vscode-textCodeBlock-background)); border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-panel-border)); }

  .msg.error { padding: 8px 10px; background: var(--vscode-inputValidation-errorBackground); border-left: 2px solid var(--vscode-errorForeground); border-radius: 0 4px 4px 0; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }

  /* Reasoning ("Thinking") block — collapsible, dim, italic */
  .reasoning { margin: 4px 0 4px 26px; font-size: 0.88em; color: var(--vscode-descriptionForeground); border-left: 2px solid var(--vscode-panel-border); padding: 2px 0 2px 10px; }
  .reasoning summary { cursor: pointer; user-select: none; opacity: 0.75; list-style: none; padding: 2px 0; display: inline-flex; align-items: center; gap: 6px; }
  .reasoning summary::-webkit-details-marker { display: none; }
  .reasoning summary::before { content: '▸'; display: inline-block; font-size: 0.8em; transition: transform 0.1s; opacity: 0.7; }
  .reasoning[open] summary::before { transform: rotate(90deg); }
  .reasoning summary:hover { opacity: 1; }
  .reasoning summary .label { font-weight: 500; }
  .reasoning summary[data-streaming="true"] .label::after { content: ''; display: inline-block; width: 5px; height: 5px; margin-left: 8px; border-radius: 50%; background: var(--vscode-charts-blue); animation: pulse 1.1s ease-in-out infinite; vertical-align: middle; }
  .reasoning .body { white-space: pre-wrap; word-break: break-word; padding: 4px 0 2px; opacity: 0.9; font-style: italic; line-height: 1.5; max-height: 360px; overflow-y: auto; }

  /* Tool call: tree-like */
  .tool { font-family: var(--vscode-editor-font-family); font-size: 0.88em; padding: 2px 0 2px 18px; margin: 4px 0; position: relative; border: none; background: transparent; }
  .tool::before { content: '⎿'; position: absolute; left: 2px; top: 2px; opacity: 0.5; }
  .tool summary { cursor: pointer; user-select: none; opacity: 0.85; list-style: none; padding: 2px 0; }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary:hover { opacity: 1; }
  .tool[data-error="true"] summary { color: var(--vscode-errorForeground); }
  .tool pre { margin: 4px 0 4px 4px; padding: 6px 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); border-radius: 4px; font-size: 0.95em; }
  .tool .tool-progress-log { max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .tool .tool-args-stream { max-height: 300px; overflow: auto; white-space: pre-wrap; word-break: break-all; opacity: 0.8; }
  .tool[data-running="true"] summary::after { content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); animation: pulse 1.1s ease-in-out infinite; vertical-align: middle; }

  /* Rich tool cards: propose_edit diff / read_file ranges / write_file */
  .tool summary .tc-tag { font-weight: 600; opacity: 0.95; }
  .tool summary .tc-path { color: var(--vscode-textLink-foreground); }
  .tool summary .tc-stat { margin-left: 6px; font-size: 0.9em; opacity: 0.8; }
  .tool summary .tc-add { color: var(--vscode-charts-green, #4caf50); }
  .tool summary .tc-del { color: var(--vscode-charts-red, #f14c4c); }
  .tc-file { margin: 4px 0 6px 4px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; overflow: hidden; background: var(--vscode-editor-background); }
  .tc-file-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.92em; }
  .tc-file-head .tc-file-name { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .tc-file-head .tc-file-name:hover { text-decoration: underline; }
  .tc-file-head .tc-file-name.tc-file-name-review { color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  .tc-file-head .tc-file-name:hover { text-decoration: underline; }
  .tc-file-head .tc-file-meta { margin-left: auto; opacity: 0.7; font-size: 0.9em; white-space: nowrap; }
  .tc-code { margin: 0; padding: 0; overflow: auto; max-height: 320px; font-family: var(--vscode-editor-font-family); font-size: 0.92em; line-height: 1.5; background: var(--vscode-editor-background); }
  .tc-code .tc-row { display: flex; align-items: flex-start; white-space: pre; }
  .tc-code .tc-ln { flex: 0 0 auto; width: 46px; box-sizing: border-box; padding: 0 8px 0 6px; text-align: right; color: var(--vscode-editorLineNumber-foreground); opacity: 0.55; user-select: none; -webkit-user-select: none; border-right: 1px solid var(--vscode-panel-border); margin-right: 8px; }
  .tc-code .tc-txt { flex: 1 1 auto; min-width: 0; padding-right: 10px; white-space: pre-wrap; word-break: break-word; }
  /* Visual gap between stacked collect_context sub-result cards. */
  .tc-stream-preview > .tc-file + .tc-file, .tool > div > .tc-file + .tc-file { margin-top: 8px; }
  .tc-code .tc-row.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(76,175,80,0.16)); }
  .tc-code .tc-row.add .tc-ln::before { content: '+'; }
  .tc-code .tc-row.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(241,76,76,0.16)); }
  .tc-code .tc-row.del .tc-ln::before { content: '-'; }
  .tc-code .tc-row.ctx { opacity: 0.78; }
  .tc-code .tc-row.add .tc-ln, .tc-code .tc-row.del .tc-ln { opacity: 0.9; }
  .tc-empty { padding: 6px 10px; opacity: 0.6; font-style: italic; }

  .iter-pill { margin: 8px 0 4px; opacity: 0.55; font-size: 0.8em; }
  .pill { font-size: 0.78em; padding: 2px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .ask { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); padding: 10px; border-radius: 6px; margin: 8px 0; }
  .ask .options { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .ask button { padding: 4px 10px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font-size: 0.9em; }
  .ask button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .ask button:disabled { cursor: not-allowed; }
  .ask button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .ask button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .ask button.decision-accept { background: var(--vscode-charts-green, #2ea043); color: #fff; font-weight: 600; }
  .ask button.decision-accept:hover:not(:disabled) { filter: brightness(1.1); }
  .ask button.decision-reject { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  .ask button.decision-reject:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .decision-panel { border-color: var(--vscode-charts-orange, #d18616); }

  /* ============ Clarification ask (single / multi / text) ============ */
  .ask-clarify { border-color: var(--vscode-charts-blue, #4ea1f3); }
  .ask-clarify .ask-header { display: flex; align-items: flex-start; gap: 8px; }
  .ask-clarify .ask-mode { flex: 0 0 auto; font-size: 0.72em; padding: 2px 7px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .ask-clarify .ask-question { flex: 1 1 auto; font-weight: 500; line-height: 1.35; }
  .ask-clarify .ask-choices { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .ask-clarify .ask-choice { text-align: left; padding: 7px 10px; border-radius: 5px; cursor: pointer; }
  .ask-clarify .ask-choice-label { font-weight: 500; }
  .ask-clarify .ask-choice-desc { font-size: 0.85em; opacity: 0.78; margin-top: 2px; line-height: 1.35; }
  .ask-clarify .ask-check-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 6px; border-radius: 4px; cursor: pointer; }
  .ask-clarify .ask-check-row:hover:not(.disabled) { background: var(--vscode-list-hoverBackground); }
  .ask-clarify .ask-check-row input[type="checkbox"] { margin-top: 3px; }
  .ask-clarify .ask-check-text { flex: 1 1 auto; min-width: 0; }
  .ask-clarify .ask-text { width: 100%; margin-top: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px 7px; border-radius: 4px; font: inherit; box-sizing: border-box; }
  .ask-clarify.answered { opacity: 0.78; border-color: var(--vscode-panel-border); }
  .ask-clarify.cancelled .ask-answer { color: var(--vscode-errorForeground); }
  .ask-clarify .ask-answer { margin-top: 8px; font-size: 0.88em; opacity: 0.85; font-style: italic; }
  /* Once submitted, drop the question/options framing entirely and only keep the
     selected option(s), styled like a regular user reply line. */
  .ask-clarify.collapsed { background: var(--vscode-textBlockQuote-background); border: none; border-left: 2px solid var(--vscode-textLink-foreground); border-radius: 0 4px 4px 0; padding: 6px 10px; opacity: 0.95; }
  .ask-clarify.collapsed .ask-reply { display: flex; gap: 8px; line-height: 1.5; word-wrap: break-word; }
  .ask-clarify.collapsed .ask-reply .gutter { color: var(--vscode-textLink-foreground); font-weight: 700; flex-shrink: 0; user-select: none; }
  .ask-clarify.collapsed .ask-reply .body { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; }

  /* ============ Pending edits banner (sticky, above composer) ============ */
  #pendingBanner { display: none; padding: 8px 10px; margin: 0 12px 8px; border-radius: 8px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-charts-orange, #d18616); flex-shrink: 0; }
  #pendingBanner.visible { display: flex; flex-direction: column; gap: 6px; }
  #pendingBanner .header { display: flex; align-items: center; gap: 8px; }
  #pendingBanner .icon { font-size: 1em; opacity: 0.85; }
  #pendingBanner .text { flex: 1; min-width: 0; line-height: 1.35; }
  #pendingBanner .text .title { font-weight: 600; font-size: 0.88em; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
  #pendingBanner .text .title .chevron { font-size: 0.75em; opacity: 0.7; transition: transform 0.15s ease; display: inline-block; }
  #pendingBanner.collapsed .text .title .chevron { transform: rotate(-90deg); }
  #pendingBanner .text .summary { font-size: 0.78em; opacity: 0.7; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pendingBanner .actions { display: flex; gap: 4px; flex-shrink: 0; }
  #pendingBanner button { padding: 4px 10px; border-radius: 5px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font-size: 0.85em; }
  #pendingBanner button.review { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  #pendingBanner button.review:hover { background: var(--vscode-toolbar-hoverBackground); }
  #pendingBanner button.accept { background: var(--vscode-charts-green, #2ea043); color: #fff; font-weight: 600; border-color: transparent; }
  #pendingBanner button.accept:hover { filter: brightness(1.1); }
  #pendingBanner button.reject { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  #pendingBanner button.reject:hover { background: var(--vscode-toolbar-hoverBackground); }
  #pendingBanner .file-list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; margin-top: 2px; }
  #pendingBanner.collapsed .file-list { display: none; }
  #pendingBanner .file-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-size: 0.82em; line-height: 1.3; }
  #pendingBanner .file-row:hover { background: var(--vscode-list-hoverBackground); }
  #pendingBanner .file-row .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pendingBanner .file-row .fname .basename { font-weight: 500; }
  #pendingBanner .file-row .fname .dir { opacity: 0.6; font-size: 0.92em; margin-left: 4px; }
  #pendingBanner .file-row .badge { font-size: 0.75em; padding: 1px 6px; border-radius: 8px; flex-shrink: 0; }
  #pendingBanner .file-row .badge.pending { background: var(--vscode-charts-orange, #d18616); color: #fff; }
  #pendingBanner .file-row .badge.done { background: var(--vscode-charts-green, #2ea043); color: #fff; opacity: 0.7; }
  #pendingBanner .file-row .badge.new { background: var(--vscode-charts-blue, #1f6feb); color: #fff; }
  .decision-flash { padding: 4px 8px; margin: 4px 0; font-size: 0.85em; border-radius: 4px; opacity: 0.9; }
  .decision-flash.accept { color: var(--vscode-charts-green, #2ea043); }
  .decision-flash.reject { color: var(--vscode-descriptionForeground); }

  /* ============ Composer (Claude Code style) ============ */
  #composer-wrap { padding: 6px 12px 12px; background: var(--vscode-sideBar-background); flex-shrink: 0; position: relative; }
  #composer { display: flex; align-items: flex-end; gap: 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 10px; padding: 8px 8px 8px 12px; transition: border-color 0.15s, box-shadow 0.15s; }
  #composer:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  #input { flex: 1; min-height: 22px; max-height: 220px; resize: none; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; padding: 3px 0; font-family: inherit; font-size: inherit; line-height: 1.5; overflow-y: auto; }
  #input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 0.6; }

  #sendBtn { width: 28px; height: 28px; padding: 0; border: none; border-radius: 7px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.15s, transform 0.1s; }
  #sendBtn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  #sendBtn:active:not(:disabled) { transform: scale(0.94); }
  #sendBtn:disabled { cursor: not-allowed; opacity: 0.45; }
  #sendBtn svg { width: 14px; height: 14px; display: block; }
  #sendBtn .icon-stop { display: none; }
  #sendBtn[data-mode="stop"] { background: var(--vscode-charts-red, #d13438); color: #fff; position: relative; }
  #sendBtn[data-mode="stop"]:hover { background: var(--vscode-errorForeground, #f14c4c); }
  #sendBtn[data-mode="stop"] .icon-send { display: none; }
  #sendBtn[data-mode="stop"] .icon-stop { display: block; }
  #sendBtn[data-mode="stop"]::before { content: ''; position: absolute; inset: -3px; border-radius: 9px; border: 1.5px solid var(--vscode-charts-red, #d13438); opacity: 0.45; animation: ring 1.4s ease-out infinite; }
  @keyframes ring { 0% { transform: scale(0.85); opacity: 0.55; } 100% { transform: scale(1.15); opacity: 0; } }

  .composer-hint { display: flex; justify-content: space-between; align-items: center; padding: 6px 4px 0; font-size: 0.72em; opacity: 0.5; }
  .composer-hint kbd { font-family: var(--vscode-editor-font-family); padding: 0 4px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); font-size: 0.95em; }

  /* ============ History dropdown ============ */
  #history { display: none; position: absolute; top: 44px; left: 12px; right: 12px; max-height: 60vh; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 10; }
  #history.open { display: block; }
  #history .empty { padding: 14px; opacity: 0.7; text-align: center; }
  #history .item { display: flex; align-items: center; padding: 7px 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); gap: 6px; }
  #history .item:last-child { border-bottom: none; }
  #history .item:hover { background: var(--vscode-list-hoverBackground); }
  #history .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #history .item .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9em; }
  #history .item .time { font-size: 0.78em; opacity: 0.6; margin-left: 6px; }
  #history .item .del { background: transparent; border: none; color: var(--vscode-foreground); padding: 2px 6px; border-radius: 4px; opacity: 0.5; cursor: pointer; }
  #history .item .del:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; color: var(--vscode-errorForeground); }
  /* Status badge for each session in the history list. Color-coded dot +
     short label; layout mirrors the bottom status pill so it feels native. */
  #history .item .status { display: inline-flex; align-items: center; gap: 4px; font-size: 0.72em; padding: 1px 6px; border-radius: 999px; border: 1px solid transparent; flex-shrink: 0; opacity: 0.85; user-select: none; }
  #history .item .status .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
  #history .item .status[data-state="running"] { color: var(--vscode-charts-blue); border-color: color-mix(in srgb, var(--vscode-charts-blue) 35%, transparent); background: color-mix(in srgb, var(--vscode-charts-blue) 12%, transparent); }
  #history .item .status[data-state="running"] .dot { animation: histPulse 1.1s ease-in-out infinite; }
  #history .item .status[data-state="completed"] { color: var(--vscode-charts-green); border-color: color-mix(in srgb, var(--vscode-charts-green) 30%, transparent); background: color-mix(in srgb, var(--vscode-charts-green) 10%, transparent); }
  #history .item .status[data-state="stopped"] { color: var(--vscode-charts-orange, #d18616); border-color: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 30%, transparent); background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 10%, transparent); }
  #history .item .status[data-state="error"] { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
  #history .item .status[data-state="idle"] { color: var(--vscode-descriptionForeground); opacity: 0.55; }
  @keyframes histPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.7); } }
  /* Stop button only visible for running sessions. */
  #history .item .stop { background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); padding: 2px 6px; border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; display: inline-flex; align-items: center; }
  #history .item .stop:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-charts-red); border-color: var(--vscode-panel-border); opacity: 1; }
  #history .item:hover .stop { opacity: 0.65; }
  #history .item .stop svg { width: 10px; height: 10px; }

  /* ============ Lessons overlay (top-bar) ============ */
  #lessons { display: none; position: absolute; top: 44px; left: 12px; right: 12px; max-height: 70vh; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 11; }
  #lessons.open { display: block; }
  #lessons .head { display: flex; align-items: center; gap: 6px; padding: 8px 12px 6px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editorWidget-background); z-index: 1; }
  #lessons .head .title { font-weight: 600; font-size: 0.88em; }
  #lessons .head .count { font-size: 0.78em; opacity: 0.6; }
  #lessons .head .spacer { flex: 1; }
  #lessons .head .add, #lessons .head .clear { background: transparent; border: 1px solid transparent; color: var(--vscode-foreground); padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.78em; opacity: 0.75; }
  #lessons .head .add:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #lessons .head .clear { color: var(--vscode-errorForeground); }
  #lessons .head .clear:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-errorForeground); }
  #lessons .empty { padding: 20px 14px; text-align: center; opacity: 0.65; font-size: 0.85em; line-height: 1.5; }
  #lessons .section-head { padding: 8px 12px 4px; font-size: 0.74em; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; opacity: 0.55; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); position: sticky; top: 36px; z-index: 1; }
  #lessons .section-head.critical { color: var(--vscode-charts-orange, #d18616); opacity: 0.9; }
  #lessons .lesson { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 4px; }
  #lessons .lesson:last-child { border-bottom: none; }
  #lessons .lesson:hover { background: var(--vscode-list-hoverBackground); }
  #lessons .lesson.important { background: linear-gradient(90deg, rgba(209, 134, 22, 0.1), transparent 30%); border-left: 3px solid var(--vscode-charts-orange, #d18616); padding-left: 9px; }
  #lessons .lesson .star-btn { background: transparent; border: none; color: var(--vscode-foreground); padding: 0 4px; cursor: pointer; opacity: 0.4; font-size: 1em; line-height: 1; flex-shrink: 0; transition: opacity 0.15s, color 0.15s, transform 0.1s; }
  #lessons .lesson .star-btn:hover { opacity: 1; transform: scale(1.15); }
  #lessons .lesson .star-btn.on { color: var(--vscode-charts-orange, #d18616); opacity: 1; }
  #lessons .editor .important-row { display: flex; align-items: center; gap: 6px; font-size: 0.82em; opacity: 0.85; cursor: pointer; user-select: none; }
  #lessons .editor .important-row input[type="checkbox"] { margin: 0; cursor: pointer; }
  #lessons .editor .important-row .hint { opacity: 0.6; font-size: 0.92em; }
  #lessons .lesson .row1 { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  #lessons .lesson .badge { font-size: 0.72em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 0.85; font-family: var(--vscode-editor-font-family); }
  #lessons .lesson .badge.file { background: var(--vscode-charts-blue, #0db9d7); color: #fff; opacity: 0.85; }
  #lessons .lesson .badge.symbol { background: var(--vscode-charts-purple, #b180d7); color: #fff; opacity: 0.85; }
  #lessons .lesson .badge.tag { background: var(--vscode-textCodeBlock-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  #lessons .lesson .badge.global { background: transparent; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); font-style: italic; }
  #lessons .lesson .id { font-family: var(--vscode-editor-font-family); font-size: 0.7em; opacity: 0.45; margin-right: 2px; flex-shrink: 0; }
  #lessons .lesson .actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
  #lessons .lesson:hover .actions { opacity: 1; }
  #lessons .lesson .actions button { background: transparent; border: 1px solid transparent; color: var(--vscode-foreground); padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 0.78em; opacity: 0.7; }
  #lessons .lesson .actions button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-panel-border); }
  #lessons .lesson .actions button.del:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  #lessons .lesson .content { font-size: 0.9em; line-height: 1.45; word-break: break-word; cursor: text; padding: 2px 4px; border-radius: 3px; border: 1px solid transparent; }
  #lessons .lesson .content:hover { border-color: var(--vscode-panel-border); }
  #lessons .lesson .content[contenteditable="true"] { background: var(--vscode-input-background); border-color: var(--vscode-focusBorder); outline: none; }
  #lessons .lesson .meta { font-size: 0.72em; opacity: 0.45; }
  #lessons .editor { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 6px; background: var(--vscode-editorWidget-background); }
  #lessons .editor input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 7px; font-size: 0.85em; outline: none; font-family: inherit; }
  #lessons .editor input:focus { border-color: var(--vscode-focusBorder); }
  #lessons .editor textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 5px 7px; font-size: 0.85em; outline: none; font-family: inherit; resize: vertical; min-height: 50px; }
  #lessons .editor textarea:focus { border-color: var(--vscode-focusBorder); }
  #lessons .editor .row { display: flex; gap: 6px; }
  #lessons .editor .row > input { flex: 1; min-width: 0; }
  #lessons .editor .actions { display: flex; gap: 6px; justify-content: flex-end; }
  #lessons .editor button { padding: 4px 12px; border-radius: 4px; border: none; cursor: pointer; font-size: 0.82em; }
  #lessons .editor button.save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #lessons .editor button.save:hover { background: var(--vscode-button-hoverBackground); }
  #lessons .editor button.cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #lessons .editor button.cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* Empty state */
  #log .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 200px; opacity: 0.5; text-align: center; gap: 6px; padding: 20px; }
  #log .empty-state .title { font-size: 1.1em; font-weight: 600; }
  #log .empty-state .hint { font-size: 0.85em; }

  /* Rollback overlay */
  #rollbackOverlay { display: none; position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,0.45); backdrop-filter: blur(2px); align-items: center; justify-content: center; flex-direction: column; gap: 12px; pointer-events: all; }
  #rollbackOverlay.active { display: flex; }
  #rollbackOverlay .rb-spinner { width: 28px; height: 28px; border: 3px solid rgba(255,255,255,0.2); border-top-color: var(--vscode-progressBar-background, #0078d4); border-radius: 50%; animation: spin 0.8s linear infinite; }
  #rollbackOverlay .rb-label { font-size: 0.9em; color: #fff; opacity: 0.9; letter-spacing: 0.01em; }
</style>
</head>
<body>
  ${diagBannerHtml}
  <div class="topbar">
    <div id="tabs" role="tablist" aria-label="Chat sessions"></div>
    <button id="newBtn" class="icon-btn" title="New chat" aria-label="New chat">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
    </button>
    <button id="historyBtn" class="icon-btn" title="Chat history" aria-label="History">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.5"/></svg>
    </button>
    <button id="lessonsBtn" class="icon-btn" title="Lessons (recorded user corrections)" aria-label="Lessons">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h7a2 2 0 0 1 2 2v9l-2-1.4-2 1.4-2-1.4-2 1.4-1-.7V3.2a.7.7 0 0 1 .7-.7H3z"/><path d="M5.5 5.5h5M5.5 8h4"/></svg>
    </button>
    <button id="cfgBtn" class="icon-btn" title="Settings" aria-label="Settings">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M13 8a5 5 0 0 0-.1-1l1.3-1-1.3-2.2-1.6.5a5 5 0 0 0-1.7-1L9.3 1.5h-2.6L6.4 3.3a5 5 0 0 0-1.7 1l-1.6-.5L1.8 6l1.3 1A5 5 0 0 0 3 8c0 .35.04.68.1 1l-1.3 1 1.3 2.2 1.6-.5c.5.43 1.07.77 1.7 1l.3 1.8h2.6l.3-1.8c.63-.23 1.2-.57 1.7-1l1.6.5L14.2 10l-1.3-1c.06-.32.1-.65.1-1z"/></svg>
    </button>
  </div>
  <div id="history"></div>
  <div id="lessons"></div>
  <div id="status" data-state="idle" data-active="false"><span class="dot"></span><span class="label">Idle</span><span class="elapsed"></span></div>
  <div id="plan"></div>
  <div id="log">
    <div class="empty-state">
      <div class="title">BurstCode</div>
      <div class="hint">Ask anything about your codebase, or describe a change to make.</div>
    </div>
  </div>
  <div id="pendingBanner">
    <div class="header">
      <span class="icon">📝</span>
      <div class="text">
        <div class="title" id="pendingTitle" title="Click to expand/collapse the changed file list"><span class="chevron">▾</span><span class="title-text"></span></div>
        <div class="summary"></div>
      </div>
      <div class="actions">
        <button class="review" id="pendingReviewBtn" title="Open the diff editor">Review</button>
        <button class="reject" id="pendingRejectBtn" title="Roll the file(s) back to their pre-edit state">Reject All</button>
        <button class="accept" id="pendingAcceptBtn" title="Keep the edits already written to disk">Accept All</button>
      </div>
    </div>
    <div class="file-list" id="pendingFileList"></div>
  </div>
  <div id="composer-wrap">
    <div id="modelPicker" role="listbox" aria-label="Select model"></div>
    <div class="model-bar">
      <button id="modelPickerBtn" type="button" aria-haspopup="listbox" aria-expanded="false" title="Pick model">
        <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>
        <span class="label"><span class="ep">No model</span></span>
        <svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
      </button>
      <div id="ctxUsage" data-level="ok" title="Context usage">
        <svg class="ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="bg" cx="12" cy="12" r="9"/>
          <circle class="fg" cx="12" cy="12" r="9" transform="rotate(-90 12 12)" stroke-dasharray="56.55" stroke-dashoffset="56.55"/>
        </svg>
        <span class="pct">0%</span>
        <span class="tokens">0/0</span>
      </div>
    </div>
    <div id="composer">
      <textarea id="input" rows="1" placeholder="Ask BurstCode anything..."></textarea>
      <button id="sendBtn" title="Send (Enter)" aria-label="Send" data-mode="send">
        <svg class="icon-send" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>
        <svg class="icon-stop" viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/></svg>
      </button>
    </div>
    <div class="composer-hint">
      <span><kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline</span>
      <button id="bgStatus" type="button" data-phase="disabled" title="Background explorer disabled — click to open activity log">
        <span class="dot" aria-hidden="true"></span>
        <span class="label">BG off</span>
      </button>
    </div>
  </div>
  <div id="rollbackOverlay" aria-live="assertive" aria-label="Rolling back...">
    <div class="rb-spinner"></div>
    <div class="rb-label">Rolling back...</div>
  </div>
<script nonce="${nonce}">
${diagScript}
const vscode = acquireVsCodeApi();
const WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
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
    if (ch === '/' || ch === '\\\\') { cut = i; break; }
  }
  const base = cut >= 0 ? s.slice(cut + 1) : s;
  return base.length > 22 ? base.slice(0, 21) + '\u2026' : base;
}
function setBgStatus(s) {
  if (!s || typeof s !== 'object') {
    bgStatusEl.dataset.phase = 'disabled';
    bgStatusLabelEl.textContent = 'BG off';
    bgStatusEl.title = 'Background explorer disabled \u2014 click to manage';
    return;
  }
  bgStatusEl.dataset.phase = s.phase || 'disabled';
  let label = 'BG ' + (s.phase || '');
  switch (s.phase) {
    case 'disabled': label = 'BG off'; break;
    case 'idle-waiting': label = 'BG idle'; break;
    case 'running': label = 'BG \u00b7 ' + (shortFile(s.currentFile) || 'analysing\u2026'); break;
    case 'paused-by-chat': label = 'BG paused (chat)'; break;
    case 'paused-by-activity': label = 'BG paused'; break;
    case 'no-workspace': label = 'BG (no folder)'; break;
    case 'error': label = 'BG error'; break;
  }
  bgStatusLabelEl.textContent = label;
  const testsLine = (s.testsRun > 0)
    ? ('Tests: ' + s.testsRun + ' run \u2014 \u2713 ' + s.testsPassed + ' / \u2717 ' + s.testsFailed + ' / \u2013 ' + s.testsSkipped)
    : ('Tests generated: ' + (s.testsGenerated || 0) + ' (auto-run off)');
  const recent = Array.isArray(s.recentActivity) ? s.recentActivity.slice(0, 3) : [];
  const NL = '\\n';
  const recentTip = recent.length
    ? (NL + 'Recent:' + NL + recent.map((e) => '  \u00b7 ' + new Date(e.ts).toLocaleTimeString() + ' ' + e.message).join(NL))
    : '';
  bgStatusEl.title =
    'Background explorer \u2014 ' + s.phase + NL +
    (s.detail || '') + NL +
    (s.currentFile ? 'Current: ' + s.currentFile + NL : '') +
    'Files analysed: ' + (s.filesProcessed || 0) + '  \u00b7  Bugs: ' + (s.bugsFound || 0) + NL +
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
// Also close on scroll / resize \u2014 the anchor would otherwise drift.
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
      try { it.action(); } catch (_) { /* swallow \u2014 menu must not leak */ }
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
// the session's title, a status-colored dot, and a close (\u00d7) button. The
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
    tab.title = s.title + (s.status && s.status !== 'idle' ? ' \u00b7 ' + s.status : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Close tab (chat stays in history)';
    close.innerHTML = '\u00d7';
    // Close \u2192 just remove from the working set. Does NOT delete the
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
    // Right-click \u2192 floating context menu (Close / Close Others / Close All / \u2026).
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
  // (No trailing "+" inside the strip \u2014 the New chat icon lives in the
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
    // Status badge \u2014 only rendered for non-trivial states. Idle sessions
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
    // Per-row stop button \u2014 only meaningful while running. Stays in the
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
    del.textContent = '\u2715';
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
    if (e.kind === 'user') addUserMsg(e.text, e.messageIndex, e.checkpointRef);
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
      pill.innerHTML = '<span class="pill">\u21bb auto-continue ' + count + '/' + max + '</span>';
      log.appendChild(pill);
    } else if (p.kind === 'auto-resume') {
      const pill = document.createElement('div');
      pill.className = 'iter-pill';
      const attempt = (p.payload && p.payload.attempt) || 1;
      const max = (p.payload && p.payload.max) || 1;
      pill.innerHTML = '<span class="pill">\u21bb auto-resume ' + attempt + '/' + max + '</span>';
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
  // Running tools \u2014 rebuild each as an open details element.
  const tools = Array.isArray(snap.runningTools) ? snap.runningTools : [];
  for (const t of tools) {
    const det = document.createElement('details');
    det.className = 'tool';
    det.dataset.running = 'true';
    det.open = false;
    const sum = document.createElement('summary');
    let argSnippet = '';
    try { argSnippet = JSON.stringify(t.args).slice(0, 200); } catch (_) { argSnippet = ''; }
    sum.textContent = '\u{1F527} ' + t.name + '(' + argSnippet + ') \u00b7 running...';
    det.appendChild(sum);
    if (Array.isArray(t.progress) && t.progress.length) {
      const progPre = document.createElement('pre');
      progPre.className = 'tool-progress-log';
      progPre.textContent = t.progress.join('\\n');
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
  return String(s).replace(/[&<>\"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---- Rich tool-call rendering --------------------------------------------
// propose_edit / write_file render as a diff/code editor, read_file /
// collect_context render as "which lines were read" cards. Anything else
// falls back to the plain <pre> result dump.

function tcBaseName(p) {
  const s = String(p || '');
  const m = s.replace(/\\\\/g, '/').split('/');
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
  const a = (oldStr == null ? '' : String(oldStr)).split('\\n');
  const b = (newStr == null ? '' : String(newStr)).split('\\n');
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
    const edits = Array.isArray(a.edits) ? a.edits : (a.path ? [a] : []);
    for (const e of edits) {
      if (e && e.path) files.push(tcBaseName(e.path));
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
    const edits = Array.isArray(a.edits) ? a.edits : (a.path ? [a] : []);
    if (!edits.length) return null;
    for (const e of edits) {
      const rows = tcLineDiff(e && e.oldText, e && e.newText, e && e.startLine);
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
    const lines = content.split('\\n');
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
      const lines = text.split('\\n');
      // Drop the tool's own "# path (lines a-b)" header line if present.
      const bodyLines = lines.length && /^#\\s/.test(lines[0]) ? lines.slice(1) : lines;
      // read_file prefixes every content line with a right-padded line number
      // followed by a tab ("    1\\t<code>"). The panel renders its own number in
      // the .tc-ln gutter, so strip that prefix to avoid showing it twice.
      const rows = bodyLines.map((t, i) => ({ kind: 'ctx', newNo: Number(meta.start) + i, text: String(t).replace(/^\\s*\\d+\\t/, '') }));
      const code = tcCodeBlock(rows, 'plain');
      const metaText = (meta.end - meta.start + 1) + ' lines · ' + (meta.totalLines || '?') + ' total'
        + (meta.hasPendingEdits ? ' · pending' : '');
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
  const re = /^=====\\s*(.+?)\\s*=====$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(src))) {
    marks.push({ title: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  if (!marks.length) return [];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const body = src.slice(marks[i].bodyStart, end).replace(/^\\n+/, '').replace(/\\s+$/, '');
    // First line of a section body is often a "# count" / "# path" summary.
    let title = marks[i].title;
    let meta = '';
    const firstNl = body.indexOf('\\n');
    const firstLine = firstNl >= 0 ? body.slice(0, firstNl) : body;
    if (/^#\\s/.test(firstLine)) meta = firstLine.replace(/^#\\s*/, '');
    out.push({ title, meta, body });
  }
  return out;
}

function metaTextPath(meta) {
  try {
    if (meta && meta.uri) {
      const u = String(meta.uri);
      return decodeURIComponent(u.replace(/^file:\\/\\//, ''));
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
      else if (ch === '\\\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) { if (esc) out += '\\\\'; out += '"'; }
  // Drop a dangling trailing comma so closing is valid.
  out = out.replace(/,\\s*$/, '');
  // Drop a dangling key-without-value at the end of an object, e.g. the buffer
  // stopped at {"summary" or {"summary": — without this the closer produces
  // {"summary"} which is invalid JSON and we'd fall back to a raw-JSON flash.
  if (stack[stack.length - 1] === '{') {
    out = out.replace(/(\\{)\\s*$/, '$1');                       // { with nothing after
    out = out.replace(/,\\s*"(?:[^"\\\\]|\\\\.)*"\\s*$/, '');       // , "danglingKey"
    out = out.replace(/(\\{)\\s*"(?:[^"\\\\]|\\\\.)*"\\s*$/, '$1');  // { "danglingKey"
    out = out.replace(/:\\s*$/, ': null');                       // key: <value not yet streamed>
    out = out.replace(/,\\s*$/, '');                             // re-trim after the above
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
  // Per CommonMark, a fence may be indented up to 3 spaces; that prefix is
  // then stripped from every content line so XML / YAML / etc. nested inside
  // a list item don't render with phantom leading whitespace before each line.
  text = text.replace(/(^|\\n)([ \\t]{0,3})\`\`\`([a-zA-Z0-9_+\-.#]*)\\n([\\s\\S]*?)(?:\\n[ \\t]{0,3}\`\`\`|$)/g, (m, lead, indent, lang, code) => {
    if (indent && indent.length > 0) {
      const dedent = new RegExp('^[ \\\\t]{0,' + indent.length + '}', 'gm');
      code = code.replace(dedent, '');
    }
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return lead + '\\u0000CODEBLOCK' + idx + '\\u0000';
  });
  // Inline code
  const inlineCodes = [];
  text = text.replace(/\`([^\`\\n]+)\`/g, (m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return '\\u0000INLINECODE' + idx + '\\u0000';
  });
  // Escape HTML now that code segments are extracted.
  text = escapeHtml(text);

  // Parse block-level structure. Recursive containers (blockquotes) call
  // renderBlocks (NOT renderMarkdown) so they SHARE the codeBlocks/inlineCodes
  // arrays extracted above. The previous code recursed via renderMarkdown,
  // which re-ran extraction on text that already contained \\u0000INLINECODE
  // placeholders -- its fresh (empty) inlineCodes array then made every
  // placeholder restore to undefined, and raw.trim() later threw, truncating
  // the whole message at the first blockquote.
  let html = renderBlocks(text, codeBlocks, inlineCodes);

  // Restore inline code — detect @file-path citations and make them clickable
  html = html.replace(/\\u0000INLINECODE(\\d+)\\u0000/g, (m, idx) => {
    const raw = inlineCodes[+idx];
    if (raw == null) return '';
    const fp = parseFilePath(raw);
    if (fp) {
      const label = escapeHtml(fileDisplayLabel(fp.path, fp.line, fp.end));
      return '<a class="file-link" href="#" data-file-path="' + escapeHtml(fp.path) + '" data-file-line="' + fp.line + '" title="' + escapeHtml(fp.path + (fp.line ? ':' + fp.line : '')) + '"><code>' + label + '</code></a>';
    }
    const sym = /^([A-Za-z_$][\w$.]*)\(\s*\)$/.exec(raw.trim());
    if (sym) {
      return '<a class="symbol-link" href="#" data-symbol-name="' + escapeHtml(sym[1]) + '" title="Go to: ' + escapeHtml(sym[1]) + '"><code>' + escapeHtml(raw) + '</code></a>';
    }
    return '<code>' + escapeHtml(raw) + '</code>';
  });
  // Restore fenced code blocks — detect @file-path lang to render clickable header
  html = html.replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, (m, idx) => {
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
// replaced with \\u0000CODEBLOCK / \\u0000INLINECODE placeholders and HTML-escaped
// by renderMarkdown. codeBlocks/inlineCodes are threaded through so nested
// containers (blockquotes) can recurse here WITHOUT re-extracting placeholders.
function renderBlocks(text, codeBlocks, inlineCodes) {
  const lines = text.split('\\n');
  const out = [];
  let i = 0;
  const flushParagraph = (buf) => {
    if (buf.length === 0) return;
    const joined = buf.join(' ').replace(/\\s+/g, ' ').trim();
    if (joined) out.push('<p>' + applyInline(joined) + '</p>');
  };
  while (i < lines.length) {
    const line = lines[i];
    // Heading
    const h = /^(#{1,6})\\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push('<h' + level + '>' + applyInline(h[2].trim()) + '</h' + level + '>');
      i++;
      continue;
    }
    // Horizontal rule
    if (/^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // Blockquote (consecutive). Recurse into renderBlocks with the SAME
    // placeholder arrays so inline code inside the quote resolves correctly.
    if (/^\\s*&gt;\\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\\s*&gt;\\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\\s*&gt;\\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderBlocks(buf.join('\\n'), codeBlocks, inlineCodes) + '</blockquote>');
      continue;
    }
    // Unordered list
    if (/^\\s*[-*+]\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\\s*[-*+]\\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((t) => '<li>' + applyInline(t) + '</li>').join('') + '</ul>');
      continue;
    }
    // Ordered list
    if (/^\\s*\\d+\\.\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\\s*\\d+\\.\\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((t) => '<li>' + applyInline(t) + '</li>').join('') + '</ol>');
      continue;
    }
    // GitHub-style table: | col | col |\\n| --- | --- |
    if (/^\\s*\\|.+\\|\\s*$/.test(line) && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{2,}.*\\|/.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2; // skip header + sep
      const bodyRows = [];
      while (i < lines.length && /^\\s*\\|.+\\|\\s*$/.test(lines[i])) {
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
    if (/^\\u0000CODEBLOCK\\d+\\u0000$/.test(line.trim())) {
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
           !/^(#{1,6})\\s+/.test(lines[i]) &&
           !/^\\s*[-*+]\\s+/.test(lines[i]) &&
           !/^\\s*\\d+\\.\\s+/.test(lines[i]) &&
           !/^\\s*&gt;\\s?/.test(lines[i]) &&
           !/^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$/.test(lines[i]) &&
           !/^\\u0000CODEBLOCK\\d+\\u0000$/.test(lines[i].trim())) {
      buf.push(lines[i]);
      i++;
    }
    flushParagraph(buf);
  }
  return out.join('\\n');
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseFilePath(raw) {
  const m = /^@?((?:[A-Za-z]:[\\\\/]|\\/)[^:]*?|(?:[\w.-]+[\\/])+[\w.-]+\.[\w]{1,8})(?::(\\d+)(?:-(\\d+))?)?$/.exec(String(raw).trim());
  if (!m) return null;
  return { path: m[1], line: m[2] ? parseInt(m[2], 10) : 0, end: m[3] ? parseInt(m[3], 10) : 0 };
}
function fileDisplayLabel(path, line, end) {
  const name = path.split(/[\\\\/]/).pop() || path;
  return name + (line ? ':' + line + (end ? '-' + end : '') : '');
}
function applyInline(s) {  // [label](file:path:line) — primary file link format
  s = s.replace(/\\[([^\\]]+)\\]\\(file:([^)]+)\\)/g, (m, label, ref) => {
    const rm = /^(.*?)(?::(\\d+)(?:-(\\d+))?)?$/.exec(ref);
    const path = rm ? rm[1] : ref;
    const line = rm && rm[2] ? parseInt(rm[2], 10) : 0;
    return '<a class="file-link" href="#" data-file-path="' + escapeHtml(path) + '" data-file-line="' + line + '" title="' + escapeHtml(path + (line ? ':' + line : '')) + '">' + escapeHtml(label) + '</a>';
  });
  // [label](sym:name) — primary symbol link format
  s = s.replace(/\\[([^\\]]+)\\]\\(sym:([^)]+)\\)/g, (m, label, name) => {
    return '<a class="symbol-link" href="#" data-symbol-name="' + escapeHtml(name) + '" title="Go to: ' + escapeHtml(name) + '">' + escapeHtml(label) + '</a>';
  });
// Links [text](url)
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, (m, label, url) => {
    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // File path citations: @/abs/path.ts:line or @C:\path.ts:line in plain text
  s = s.replace(/@((?:[A-Za-z]:[\\\\/]|\\/)\\S+?)(?::(\\d+)(?:-(\\d+))?)?(?=[\\s,;!?<]|$)/g, (m, p, l1, l2) => {
    const line = l1 ? parseInt(l1, 10) : 0;
    const label = escapeHtml(fileDisplayLabel(p, line, l2 ? parseInt(l2, 10) : 0));
    return '<a class="file-link" href="#" data-file-path="' + p + '" data-file-line="' + line + '" title="' + p + (l1 ? ':' + l1 : '') + '"><code>' + label + '</code></a>';
  });
  // Bold ** or __
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic * or _ (avoid touching word_with_underscores by requiring non-word boundary)
  s = s.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*(?=[^*\\w]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\\w])_([^_\\n]+)_(?=[^_\\w]|$)/g, '$1<em>$2</em>');
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

function addUserMsg(text, messageIndex, checkpointRef, checkpointError) {
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
  body.textContent = text;
  el.appendChild(gutter);
  el.appendChild(body);

  // Always surface a rollback affordance on user messages — earlier
  // versions only rendered the button when a git checkpointRef was
  // captured, which silently hid the feature whenever git checkpointing
  // was disabled, failed at runtime, or the session was saved before
  // checkpoints existed (old sessions). We now show the button
  // unconditionally and degrade gracefully when no checkpoint is
  // available: the click handler is the same, but the backend falls
  // back to chat-only truncation after an explicit confirmation.
  if (typeof messageIndex === 'number') {
    const btn = document.createElement('button');
    btn.className = 'rollback-btn';
    // Tooltip carries the exact reason when checkpointing failed (passed up
    // from GitCheckpoint.createCheckpoint via the user-message payload), so
    // the user can diagnose a broken setup without opening the output panel.
    btn.title = checkpointRef
      ? 'Roll back code & chat to the state right before this prompt'
      : checkpointError
        ? 'No checkpoint for this prompt (' + checkpointError + ') — click to truncate chat history only'
        : 'No checkpoint captured for this prompt — click to truncate chat history only';
    if (!checkpointRef) btn.dataset.chatOnly = 'true';
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 3v3h3"/></svg><span>Rollback</span>';
    btn.addEventListener('click', () => {
      // Read ref from dataset at click time so that async-created checkpoints
      // (whose ref arrives via 'update-checkpoint-ref' after this button was
      // first rendered) are correctly picked up.
      vscode.postMessage({
        type: 'rollback',
        payload: { ref: el.dataset.checkpointRef || '', messageIndex }
      });
    });
    el.appendChild(btn);
  }
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

function setBusy(v) {
  busy = v;
  sendBtn.dataset.mode = v ? 'stop' : 'send';
  sendBtn.title = v ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', v ? 'Stop' : 'Send');
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
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
        // Don't go idle \u2014 a live-state-replay event will follow with the
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
      // on every broadcast \u2014 status badges, active highlight, ordering all
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
        msg.payload.checkpointError
      );
      break;
    case 'update-checkpoint-ref': {
      // Checkpoint was created asynchronously after the user message was
      // rendered. Update the rollback button so clicking it sends the real ref.
      const cpIdx = msg.payload.messageIndex;
      const cpRef = msg.payload.ref;
      if (cpRef) {
        const msgEl = log.querySelector('[data-message-index="' + cpIdx + '"]');
        if (msgEl) {
          msgEl.dataset.checkpointRef = cpRef;
          const rollBtn = msgEl.querySelector('.rollback-btn');
          if (rollBtn) {
            rollBtn.title = 'Roll back code & chat to the state right before this prompt';
            delete rollBtn.dataset.chatOnly;
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
      // Stream was interrupted mid-turn. Discard any partial assistant /
      // reasoning bubble so the retry's fresh stream doesn't duplicate text,
      // then drop a visible pill explaining what's happening (the previous
      // UX was "the chat silently stopped with no reason").
      clearEmptyState();
      if (activeAssistantEl && activeAssistantEl.parentNode) {
        activeAssistantEl.parentNode.removeChild(activeAssistantEl);
      }
      if (activeReasoningEl && activeReasoningEl.parentNode) {
        activeReasoningEl.parentNode.removeChild(activeReasoningEl);
      }
      activeAssistantEl = null;
      activeReasoningEl = null;
      activeStreamingToolEl = null;
      // Remove all running tool elements — execution never started (stream failed).
      for (const [key, det] of Array.from(toolElements.entries())) {
        if (det.dataset.running === 'true') {
          if (det.parentNode) det.parentNode.removeChild(det);
          toolElements.delete(key);
          runningTools.delete(key);
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
      if (!activeReasoningEl) {
        activeReasoningEl = addReasoningMsg('', { open: true, streaming: true });
      }
      const raw = (activeReasoningEl.dataset.raw || '') + msg.payload.text;
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
        const sum = activeReasoningEl.querySelector('summary');
        if (sum) delete sum.dataset.streaming;
        activeReasoningEl.open = false;
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
        const sum = activeReasoningEl.querySelector('summary');
        if (sum) delete sum.dataset.streaming;
        activeReasoningEl.open = false;
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
        if (!applyRichTool(existingDet, msg.payload.name, msg.payload.args, msg.payload.meta, null, false, false)) {
          if (existingSum) existingSum.textContent = '\u{1F527} ' + msg.payload.name + '(' + JSON.stringify(msg.payload.args).slice(0, 200) + ') \u00b7 running...';
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
      sum.textContent = '\u{1F527} ' + msg.payload.name + '(' + JSON.stringify(msg.payload.args).slice(0, 200) + ') \u00b7 running...';
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
        progPre.textContent = (progPre.textContent ? progPre.textContent + '\\n' : '') + line;
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
          if (s) s.textContent = '\u26a0 ' + (runningTools.get(key)?.name || '?') + ' \u00b7 cancelled';
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
          if (s) s.textContent = '\u26a0 ' + (runningTools.get(key)?.name || '?') + ' \u00b7 cancelled';
          toolElements.delete(key);
        }
      }
      runningTools.clear();
      setStatus(errorish ? 'error' : 'done', labels[reason] || ('Done (' + reason + ')'));
      break;
    }
    case 'models': {
      const payload = msg.payload || { chat: { baseURL: '', model: '', models: [] }, active: { model: '' }, fetched: null };
      const newChat = payload.chat || { baseURL: '', model: '', models: [] };
      const oldBaseURL = modelsState.chat.baseURL;
      modelsState.chat = newChat;
      modelsState.active = payload.active || { model: modelsState.chat.model || '' };
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
      if (modelPicker.classList.contains('open')) renderModelPicker();
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
      if (modelPicker.classList.contains('open')) renderModelPicker();
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
  input.style.height = Math.min(input.scrollHeight, max) + 'px';
}

input.addEventListener('input', autosizeInput);

sendBtn.addEventListener('click', () => {
  if (busy) {
    // While a run is in progress the button acts as Stop.
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', payload: { text } });
  input.value = '';
  autosizeInput();
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
    input.value = value.slice(0, start) + '\\n' + value.slice(end);
    input.selectionStart = input.selectionEnd = start + 1;
    return;
  }
  if (e.shiftKey) {
    // Shift+Enter -> default newline behavior
    return;
  }
  // Plain Enter -> send (ignored while busy)
  e.preventDefault();
  if (busy) return;
  sendBtn.click();
});

// ============== Model picker ==============
// Single chat profile only. Background profile is managed via Settings UI
// (or via the 'BurstCode: Background Explorer Model' command).
const modelsState = {
  chat: { baseURL: '', model: '', models: [] },
  active: { model: '' },
  fetched: { loading: false, models: null, error: null, fetchedAt: 0 }
};

function setModelPickerOpen(open) {
  if (open) {
    renderModelPicker();
    modelPicker.classList.add('open');
    modelPickerBtn.setAttribute('aria-expanded', 'true');
  } else {
    modelPicker.classList.remove('open');
    modelPickerBtn.setAttribute('aria-expanded', 'false');
  }
}

function renderModelPickerLabel() {
  const labelEl = modelPickerBtn.querySelector('.label');
  if (!labelEl) return;
  const a = modelsState.active || { model: '' };
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

  // Compose the row list: manual models first, then any fetched-only IDs.
  const manual = (chat.models || []).slice();
  const fetched = Array.isArray(cache.models) ? cache.models : [];
  const seen = new Set();
  const rows = [];
  manual.forEach((m) => { if (!seen.has(m)) { seen.add(m); rows.push({ id: m, source: 'manual' }); } });
  fetched.forEach((m) => { if (!seen.has(m)) { seen.add(m); rows.push({ id: m, source: 'fetched' }); } });

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
      badge.textContent = r.source === 'manual' ? 'manual' : 'fetched';
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
    // Close the lessons overlay so they don't stack.
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
</script>
</body>
</html>`;
  }
}
