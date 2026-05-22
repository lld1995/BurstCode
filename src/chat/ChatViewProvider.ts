import * as vscode from 'vscode';
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
  ChatMessage
} from '../llm/OpenAIClient';
import { LspBridge } from '../lsp/LspBridge';
import { estimateMessagesTokens } from '../llm/tokenizer';
import { AgentLoop } from '../agent/AgentLoop';
import { Tool } from '../agent/tools/types';
import { buildReadFileTool, listDirTool, grepSearchTool, workspaceOutlineTool } from '../agent/tools/core';
import { WorkspaceIndex } from '../context/WorkspaceIndex';
import { buildSystemPrompt } from '../agent/prompts';
import { buildLspTools } from '../agent/tools/lsp';
import { buildLangTools } from '../agent/tools/lang';
import { buildEditTools, AskUserSpec } from '../agent/tools/edits';
import { buildPlanTool, PlanStep } from '../agent/tools/plan';
import { buildLessonTools } from '../agent/tools/lessons';
import { buildShellTools } from '../agent/tools/shell';
import { buildSubagentTool } from '../agent/tools/subagent';
import { LessonStore, renderLessonsBlock } from '../memory/LessonStore';
import { CheckpointInfo, GitCheckpoint } from '../git/GitCheckpoint';
import {
  Session,
  SessionCheckpoint,
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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'burstcode.chatView';

  private view?: vscode.WebviewView;
  private currentSession?: Session;
  private currentRun?: vscode.CancellationTokenSource;
  private pendingAskUser?: { resolve: (value: string) => void; id: string };
  private configSub?: vscode.Disposable;
  private pendingEditsSub?: vscode.Disposable;
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
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('burstcode.llm')) {
        this.broadcastModels();
        this.broadcastContextUsage();
      }
    });
    this.pendingEditsSub = this.applier.onPendingStateChange((state) => {
      this.broadcastPendingEdits(state);
      // Persist a small note into the session messages so the next agent run
      // sees what the user did in between turns. The model will read this as
      // ordinary user-side context and react accordingly.
      if (state.recentDecision && this.currentSession) {
        this.currentSession.messages.push({
          role: 'user',
          content: `(System note) The user reviewed the previously queued edits — ${state.recentDecision}. Take this into account on the next instruction.`
        });
        void this.persistCurrentSession();
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

  /** True while a chat-driven agent run is active. Used by BackgroundExplorer to defer idle work. */
  isBusy(): boolean {
    return !!this.currentRun;
  }

  private broadcastPendingEdits(state: PendingState): void {
    if (!this.view) return;
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
    this.broadcastPendingEdits(this.applier.getPendingState());
  }

  private broadcastSessions(): void {
    if (!this.view) return;
    this.post({
      type: 'sessions',
      payload: {
        sessions: this.sessions.list(),
        activeId: this.currentSession?.id
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
    this.post({
      type: 'models',
      payload: {
        active: { model: activeModel },
        chat: {
          baseURL: chat.baseURL,
          model: activeModel,
          models: chat.models.slice()
        }
      }
    });
  }

  newChat(): void {
    this.currentSession = undefined;
    this.post({ type: 'reset' });
    this.broadcastSessions();
    this.broadcastContextUsage();
  }

  private async loadSession(id: string): Promise<void> {
    if (this.currentRun) {
      vscode.window.showWarningMessage('BurstCode: finish or stop the current request before switching sessions.');
      return;
    }
    const s = this.sessions.get(id);
    if (!s) {
      vscode.window.showWarningMessage('BurstCode: session not found.');
      this.broadcastSessions();
      return;
    }
    this.currentSession = s;
    this.post({ type: 'reset' });
    this.post({
      type: 'load-session',
      payload: {
        id: s.id,
        title: s.title,
        transcript: buildTranscript(s.messages, s.checkpoints),
        plan: s.plan ?? []
      }
    });
    this.broadcastSessions();
    this.broadcastContextUsage();
  }

  private async deleteSession(id: string): Promise<void> {
    await this.sessions.delete(id);
    if (this.currentSession?.id === id) {
      this.currentSession = undefined;
      this.post({ type: 'reset' });
    }
    this.broadcastSessions();
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
        this.currentRun?.cancel();
        break;
      case 'accept-all-edits':
        await this.applier.acceptAll();
        break;
      case 'reject-all-edits':
        await this.applier.rejectAll();
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
      case 'rollback': {
        const payload = (msg.payload ?? {}) as { ref?: string; messageIndex?: number };
        await this.rollbackToCheckpoint(String(payload.ref ?? ''), Number(payload.messageIndex ?? -1));
        break;
      }
      case 'ask-user-response':
        this.pendingAskUser?.resolve(String((msg.payload as { answer: string })?.answer ?? ''));
        this.pendingAskUser = undefined;
        break;
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
          this.post({ type: 'models-fetched', payload: { models } });
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
        if (id) await this.lessons.remove(id);
        this.broadcastLessons();
        break;
      }
      case 'clear-lessons':
        await this.lessons.clear();
        this.broadcastLessons();
        break;
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
  private async buildSystemPromptForRun(): Promise<string> {
    const lessonsRender = renderLessonsBlock(this.lessons.list());
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentPlan = this.currentSession?.plan;
    if (!root) {
      return buildSystemPrompt({
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
        lessonsBlock: lessonsRender.text,
        lessonsTruncated: lessonsRender.truncated,
        currentPlan
      });
    } catch (err) {
      this.logger.warn('Failed to build workspace outline', String(err));
      return buildSystemPrompt({
        workspaceRoot: root,
        lessonsBlock: lessonsRender.text,
        lessonsTruncated: lessonsRender.truncated,
        currentPlan
      });
    }
  }

  /**
   * Restore the working tree to the snapshot captured before a previous user
   * prompt was processed. Also truncates the session transcript back to that
   * point so the chat history stays consistent with the code on disk.
   */
  private async rollbackToCheckpoint(ref: string, messageIndex: number): Promise<void> {
    if (!ref || !this.currentSession || !Number.isFinite(messageIndex) || messageIndex < 0) {
      vscode.window.showWarningMessage('BurstCode: nothing to roll back to.');
      return;
    }
    if (this.currentRun) {
      vscode.window.showWarningMessage('BurstCode: stop the current request before rolling back.');
      return;
    }
    if (this.applier.getPendingState().hunks > 0) {
      const choice = await vscode.window.showWarningMessage(
        'BurstCode: there are still pending edits. Discard them and roll back?',
        { modal: true },
        'Discard & Roll Back'
      );
      if (choice !== 'Discard & Roll Back') return;
      await this.applier.rejectAll();
    }
    const confirm = await vscode.window.showWarningMessage(
      'Roll back the working tree to the state right before this prompt? Conversation after this point will also be removed. Your current working tree will first be saved as a safety checkpoint.',
      { modal: true },
      'Roll Back'
    );
    if (confirm !== 'Roll Back') return;

    const ok = await this.gitCheckpoint.restoreCheckpoint(ref);
    if (!ok) return;

    const session = this.currentSession;
    session.messages = session.messages.slice(0, messageIndex);
    session.checkpoints = (session.checkpoints ?? []).filter((c) => c.ref !== ref && c.messageIndex < messageIndex);
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
    vscode.window.showInformationMessage('BurstCode: rolled back to the previous prompt.');
  }

  private async runAgent(userText: string): Promise<void> {
    if (!userText.trim()) return;
    if (this.currentRun) {
      vscode.window.showWarningMessage('BurstCode: a request is already running.');
      return;
    }

    this.foregroundActivityEmitter.fire('chat-start');

    // Allocate (and publish) the cancellation source FIRST, before any of
    // the slow setup work below. Otherwise a user clicking Stop while we are
    // still building the system prompt or creating the git checkpoint would
    // hit `this.currentRun?.cancel()` on `undefined` and have no effect.
    const cts = new vscode.CancellationTokenSource();
    this.currentRun = cts;

    const session = this.ensureSessionForUserText(userText);
    this.ensureSystemMessageSlot(session);
    const messageIndex = session.messages.length;
    session.messages.push({ role: 'user', content: userText });

    // Kick off the two slow setup tasks in PARALLEL: creating a git
    // checkpoint (spawns `git`, can be hundreds of ms on big repos) and
    // building the workspace-outline-augmented system prompt (filesystem
    // walk, also hundreds of ms). They are independent so we don't pay for
    // them serially before the LLM stream starts.
    const checkpointPromise: Promise<CheckpointInfo | undefined> = (async () => {
      try {
        return await this.gitCheckpoint.createCheckpoint(`prompt: ${deriveTitle(userText)}`);
      } catch (err) {
        this.logger.warn('Failed to create per-prompt checkpoint', String(err));
        return undefined;
      }
    })();
    const systemPromptPromise = this.buildSystemPromptForRun();

    let checkpointRef: string | undefined;
    const cp = await checkpointPromise;
    if (cp) {
      checkpointRef = cp.ref;
      const entry: SessionCheckpoint = {
        messageIndex,
        ref: cp.ref,
        sha: cp.sha,
        createdAt: cp.createdAt,
        label: cp.label
      };
      session.checkpoints = [...(session.checkpoints ?? []), entry];
    }

    this.post({
      type: 'user-message',
      payload: { text: userText, messageIndex, checkpointRef }
    });
    this.broadcastContextUsage();
    void this.persistCurrentSession();

    const llmCfg = readLLMConfig();
    const client = new OpenAIClient(llmCfg, this.logger);
    const bridge = new LspBridge(
      vscode.workspace.getConfiguration('burstcode.lsp').get<number>('maxWaitMs') ?? 60000
    );

    const askUser = (spec: AskUserSpec): Promise<string> => {
      return new Promise<string>((resolve) => {
        const id = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.pendingAskUser = { resolve, id };
        this.post({
          type: 'ask-user',
          payload: {
            id,
            question: spec.question,
            inputType: spec.inputType,
            options: spec.options,
            allowCustomText: !!spec.allowCustomText,
            placeholder: spec.placeholder
          }
        });
        // If the run is cancelled before the user answers, unblock the agent
        // loop so it can wind down cleanly instead of hanging on this promise.
        const cancelSub = cts.token.onCancellationRequested(() => {
          if (this.pendingAskUser?.id === id) {
            this.pendingAskUser = undefined;
            this.post({ type: 'ask-user-cancel', payload: { id } });
            resolve('(cancelled by user)');
          }
          cancelSub.dispose();
        });
      });
    };

    const onPlanUpdate = (steps: PlanStep[]): void => {
      if (this.currentSession) {
        this.currentSession.plan = steps;
      }
      this.post({ type: 'plan-update', payload: { steps } });
      void this.persistCurrentSession();
    };

    const systemPrompt = await systemPromptPromise;
    const agentCfg = vscode.workspace.getConfiguration('burstcode.agent');
    const coreReadTools: Tool[] = [buildReadFileTool(this.applier), listDirTool, grepSearchTool, workspaceOutlineTool];
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
      maxPrematureStopContinues: agentCfg.get<number>('maxPrematureStopContinues') ?? 5,
      askUser,
      systemPrompt
    });

    this.post({ type: 'run-start' });

    try {
      for await (const event of agent.run(session.messages, cts.token)) {
        switch (event.type) {
          case 'assistant-delta':
            this.post({ type: 'assistant-delta', payload: { text: event.payload as string } });
            break;
          case 'reasoning-delta':
            this.post({ type: 'reasoning-delta', payload: { text: event.payload as string } });
            break;
          case 'assistant-message':
            this.post({ type: 'assistant-message', payload: event.payload });
            break;
          case 'tool-call-start':
            this.post({ type: 'tool-call-start', payload: event.payload });
            break;
          case 'tool-call-end':
            this.post({ type: 'tool-call-end', payload: event.payload });
            break;
          case 'tool-progress':
            this.post({ type: 'tool-progress', payload: event.payload });
            break;
          case 'iteration-start':
            this.post({ type: 'iteration', payload: event.payload });
            break;
          case 'auto-continue':
            this.post({ type: 'auto-continue', payload: event.payload });
            break;
          case 'auto-resume':
            this.post({ type: 'auto-resume', payload: event.payload });
            break;
          case 'context-usage':
            this.post({ type: 'context-usage', payload: event.payload });
            break;
          case 'context-compressed':
            this.post({ type: 'context-compressed', payload: event.payload });
            break;
          case 'stuck-detected':
            this.post({ type: 'stuck-detected', payload: event.payload });
            break;
          case 'error':
            this.post({ type: 'error', payload: event.payload });
            break;
          case 'done':
            this.post({ type: 'done', payload: event.payload });
            break;
        }
      }
    } catch (err) {
      this.logger.error('Agent run failed', String(err));
      this.post({ type: 'error', payload: String(err) });
    } finally {
      this.currentRun = undefined;
      cts.dispose();
      this.foregroundActivityEmitter.fire('chat-end');
      this.broadcastContextUsage();
      await this.persistCurrentSession();
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
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
  const ids = ['newBtn', 'historyBtn', 'lessonsBtn', 'cfgBtn', 'modelPickerBtn', 'sendBtn', 'bgStatus', 'input'];
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

  /* ============ Top bar ============ */
  .topbar { display: flex; align-items: center; gap: 2px; padding: 8px 12px; background: var(--vscode-sideBar-background); flex-shrink: 0; position: relative; }
  .topbar::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 1px; background: var(--vscode-panel-border); opacity: 0.5; }
  .topbar .brand { font-weight: 600; font-size: 0.92em; letter-spacing: 0.2px; opacity: 0.85; padding-right: 6px; display: inline-flex; align-items: center; gap: 6px; }
  .topbar .brand .dot { width: 6px; height: 6px; border-radius: 50%; background: linear-gradient(135deg, var(--vscode-charts-blue), var(--vscode-charts-purple)); }
  .topbar .spacer { flex: 1; }
  .topbar .icon-btn { background: transparent; color: var(--vscode-foreground); border: none; border-radius: 5px; padding: 4px; cursor: pointer; opacity: 0.65; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; transition: opacity 0.15s, background 0.15s; }
  .topbar .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .topbar .icon-btn svg { width: 15px; height: 15px; }
  .topbar .divider { width: 1px; height: 16px; background: var(--vscode-panel-border); opacity: 0.5; margin: 0 4px; }

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
  .msg.user .rollback-btn { flex-shrink: 0; background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 0.78em; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; display: inline-flex; align-items: center; gap: 3px; align-self: flex-start; }
  .msg.user:hover .rollback-btn { opacity: 0.75; }
  .msg.user .rollback-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
  .msg.user .rollback-btn svg { width: 11px; height: 11px; }

  /* Assistant: clean prose, no bubble. Rendered as Markdown. */
  .msg.assistant { padding: 2px 4px 2px 26px; line-height: 1.6; word-wrap: break-word; position: relative; }
  .msg.assistant::before { content: '⏺'; color: var(--vscode-charts-green); position: absolute; left: 6px; top: 2px; opacity: 0.85; }
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
  .tool[data-running="true"] summary::after { content: ''; display: inline-block; width: 7px; height: 7px; margin-left: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); animation: pulse 1.1s ease-in-out infinite; vertical-align: middle; }

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
</style>
</head>
<body>
  ${diagBannerHtml}
  <div class="topbar">
    <span class="brand"><span class="dot"></span>BurstCode</span>
    <span class="spacer"></span>
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
        <button class="reject" id="pendingRejectBtn" title="Discard all queued edits">Reject All</button>
        <button class="accept" id="pendingAcceptBtn" title="Apply all queued edits">Accept All</button>
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
<script nonce="${nonce}">
${diagScript}
const vscode = acquireVsCodeApi();
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
const lessonsBtn = document.getElementById('lessonsBtn');
const lessonsEl = document.getElementById('lessons');
const planEl = document.getElementById('plan');
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
let activeReasoningEl = null;
let toolElements = new Map();
let runningTools = new Map(); // id -> { name, startedAt }
let busy = false;
let sessionsCache = { sessions: [], activeId: null };
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
function forceScrollToBottom() {
  autoScroll = true;
  scheduleScrollToBottom(true);
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
  list.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'item' + (s.id === sessionsCache.activeId ? ' active' : '');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = s.title;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(s.updatedAt);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete this chat';
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (confirm('Delete this chat?')) {
        vscode.postMessage({ type: 'delete-session', payload: { id: s.id } });
      }
    };
    item.appendChild(title);
    item.appendChild(time);
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
    if (confirm('Delete all ' + lessonsCache.length + ' lessons? This cannot be undone.')) {
      vscode.postMessage({ type: 'clear-lessons' });
    }
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
    if (confirm('Delete this lesson?\\n\\n' + l.content)) {
      vscode.postMessage({ type: 'delete-lesson', payload: { id: l.id } });
    }
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
      const pre = document.createElement('pre');
      pre.textContent = (e.text || '').slice(0, 4000);
      det.appendChild(pre);
      log.appendChild(det);
    }
  });
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

function renderMarkdown(src) {
  if (!src) return '';
  const codeBlocks = [];
  let text = String(src);
  // Fenced code blocks. Allow unterminated trailing block (during streaming).
  text = text.replace(/\`\`\`([a-zA-Z0-9_+\-.#]*)\\n([\\s\\S]*?)(?:\`\`\`|$)/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').trim(), code });
    return '\\u0000CODEBLOCK' + idx + '\\u0000';
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

  // Block-level transforms operate line-by-line.
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
    // Blockquote (consecutive)
    if (/^\\s*&gt;\\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\\s*&gt;\\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\\s*&gt;\\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderMarkdown(buf.join('\\n')) + '</blockquote>');
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
      let html = '<table><thead><tr>' + headerCells.map((c) => '<th>' + applyInline(c) + '</th>').join('') + '</tr></thead>';
      if (bodyRows.length) {
        html += '<tbody>' + bodyRows.map((row) => '<tr>' + row.map((c) => '<td>' + applyInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      }
      html += '</table>';
      out.push(html);
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

  let html = out.join('\\n');

  // Restore inline code (escape its body)
  html = html.replace(/\\u0000INLINECODE(\\d+)\\u0000/g, (m, idx) => '<code>' + escapeHtml(inlineCodes[+idx]) + '</code>');
  // Restore fenced code blocks
  html = html.replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, (m, idx) => {
    const { lang, code } = codeBlocks[+idx];
    const langAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    const head = '<div class="code-head"><span class="lang">' + (lang ? escapeHtml(lang) : 'text') + '</span><button class="copy" type="button" title="Copy">⧉</button></div>';
    return '<pre>' + head + '<code' + langAttr + '>' + escapeHtml(code) + '</code></pre>';
  });
  return html;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function applyInline(s) {
  // Links [text](url)
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, (m, label, url) => {
    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
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

function addUserMsg(text, messageIndex, checkpointRef) {
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

  if (checkpointRef && typeof messageIndex === 'number') {
    const btn = document.createElement('button');
    btn.className = 'rollback-btn';
    btn.title = 'Roll back code & chat to the state before this prompt';
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 3v3h3"/></svg><span>Rollback</span>';
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'rollback', payload: { ref: checkpointRef, messageIndex } });
    });
    el.appendChild(btn);
  }
  log.appendChild(el);
  // The user just submitted a prompt; jump them to the bottom regardless of
  // where they were reading, and re-arm auto-follow for the upcoming run.
  forceScrollToBottom();
  return el;
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
    case 'reset':
      log.innerHTML = '';
      activeAssistantEl = null;
      activeReasoningEl = null;
      toolElements.clear();
      runningTools.clear();
      currentIter = 0;
      renderPlan([]);
      setStatus('idle', 'Idle');
      showEmptyState();
      break;
    case 'load-session':
      renderTranscript(msg.payload.transcript || []);
      renderPlan(msg.payload.plan || []);
      runningTools.clear();
      currentIter = 0;
      setStatus('idle', 'Idle');
      break;
    case 'plan-update':
      renderPlan(msg.payload.steps || []);
      break;
    case 'sessions':
      sessionsCache = msg.payload || { sessions: [], activeId: null };
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
      addUserMsg(msg.payload.text, msg.payload.messageIndex, msg.payload.checkpointRef);
      break;
    case 'run-start': {
      activeAssistantEl = null;
      activeReasoningEl = null;
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
      const raw = (activeAssistantEl.dataset.raw || '') + msg.payload.text;
      activeAssistantEl.dataset.raw = raw;
      const mdEl = activeAssistantEl.querySelector('.md');
      if (mdEl) {
        mdEl.innerHTML = renderMarkdown(raw);
        bindCodeCopy(mdEl);
      }
      scrollToBottom();
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
      const det = document.createElement('details');
      det.className = 'tool';
      det.dataset.running = 'true';
      det.open = false;
      const sum = document.createElement('summary');
      sum.textContent = '\u{1F527} ' + msg.payload.name + '(' + JSON.stringify(msg.payload.args).slice(0, 200) + ') \u00b7 running...';
      det.appendChild(sum);
      log.appendChild(det);
      const key = msg.payload.id || msg.payload.name + Date.now();
      toolElements.set(key, det);
      runningTools.set(key, { name: msg.payload.name, startedAt: Date.now() });
      const names = Array.from(runningTools.values()).map((t) => t.name).join(', ');
      setStatus('tool', 'Running ' + names + '...');
      scrollToBottom();
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
        const sum = det.querySelector('summary');
        sum.textContent = (msg.payload.isError ? '⚠ ' : '✓ ') + msg.payload.name + ' · done';
        const pre = document.createElement('pre');
        pre.textContent = (msg.payload.result || '').slice(0, 4000);
        det.appendChild(pre);
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
        vscode.postMessage({ type: 'ask-user-response', payload: { id: askId, answer: answer } });
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
      runningTools.clear();
      setStatus('error', 'Error');
      break;
    case 'done': {
      setBusy(false);
      runningTools.clear();
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
      setStatus(errorish ? 'error' : 'done', labels[reason] || ('Done (' + reason + ')'));
      break;
    }
    case 'models': {
      const payload = msg.payload || { chat: { baseURL: '', model: '', models: [] }, active: { model: '' } };
      modelsState.chat = payload.chat || { baseURL: '', model: '', models: [] };
      modelsState.active = payload.active || { model: modelsState.chat.model || '' };
      renderModelPickerLabel();
      if (modelPicker.classList.contains('open')) renderModelPicker();
      break;
    }
    case 'models-fetched': {
      const { models, error } = msg.payload || {};
      modelsState.fetched = {
        loading: false,
        models: Array.isArray(models) ? models : (modelsState.fetched && modelsState.fetched.models) || null,
        error: error || null
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
  fetched: { loading: false, models: null, error: null }
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
pendingReviewBtn.addEventListener('click', () => vscode.postMessage({ type: 'review-edits' }));
// Click the title to collapse/expand the changed-file list.
pendingTitleRow.addEventListener('click', () => {
  pendingBanner.classList.toggle('collapsed');
});
pendingAcceptBtn.addEventListener('click', () => {
  pendingAcceptBtn.disabled = true;
  pendingRejectBtn.disabled = true;
  vscode.postMessage({ type: 'accept-all-edits' });
});
pendingRejectBtn.addEventListener('click', () => {
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
