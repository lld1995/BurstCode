import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from '../util/Logger';
import {
  ChatMessage,
  LLMConfig,
  OpenAIClient,
  getActiveEndpoint,
  readEndpoints,
  readLLMConfig
} from '../llm/OpenAIClient';
import { ChatViewProvider } from '../chat/ChatViewProvider';
import { WorkspaceIndex } from '../context/WorkspaceIndex';
import { defaultOutlineOptions } from '../context/WorkspaceOutline';
import {
  BACKGROUND_SYSTEM_PROMPT,
  buildAnalysisUserMessage,
  BACKGROUND_BRIEF_PROMPT,
  buildBriefUserMessage,
  BACKGROUND_TOPIC_SYSTEM_PROMPT,
  buildTopicUserMessage
} from './prompts';
import { runGeneratedTest, TestRunResult } from './TestRunner';
import { HunkApplier } from '../edits/HunkApplier';
import { AgentLoop } from '../agent/AgentLoop';
import {
  readFileTool,
  listDirTool,
  grepSearchTool,
  workspaceOutlineTool
} from '../agent/tools/core';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

interface BackgroundConfig {
  enabled: boolean;
  /** Idle gap (ms) the user must be inactive before a cycle starts. */
  idleThresholdMs: number;
  /** Minimum gap between cycles, even on a busy weekend. */
  minIntervalMs: number;
  /** Files analysed per cycle (each file = one LLM call). */
  filesPerCycle: number;
  /** How many investigation topics to run concurrently within one cycle. */
  maxConcurrentTopics: number;
  /** Source-file extensions we will scan. */
  includeExtensions: string[];
  /** Skip files larger than this (bytes). */
  maxFileBytes: number;
  /** Output directory relative to workspace root. */
  outputDir: string;
  /** Endpoint name override (empty → use chat's active endpoint). */
  endpoint: string;
  /** Model id override (empty → use endpoint's first model / chat's active). */
  model: string;
  /** Temperature override. NaN → endpoint default. */
  temperature: number;
  /** Context window override. 0 → endpoint default. */
  contextWindow: number;
  /** How long to wait for a single LLM analysis call (ms). */
  perFileTimeoutMs: number;
  /** When true, attempt to actually execute generated unit tests and record results. */
  runGeneratedTests: boolean;
  /** Per-test execution timeout. */
  testRunTimeoutMs: number;
}

const DEFAULT_INCLUDE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'rb', 'php', 'swift', 'scala', 'lua', 'dart'
];

function readConfig(): BackgroundConfig {
  const cfg = vscode.workspace.getConfiguration('quickcode.background');
  const exts = cfg.get<string[]>('includeExtensions');
  return {
    enabled: cfg.get<boolean>('enabled') ?? false,
    idleThresholdMs: Math.max(5000, cfg.get<number>('idleThresholdMs') ?? 10000),
    minIntervalMs: Math.max(1000, cfg.get<number>('minIntervalMs') ?? 30000),
    filesPerCycle: Math.max(1, cfg.get<number>('filesPerCycle') ?? 1),
    maxConcurrentTopics: Math.max(1, cfg.get<number>('maxConcurrentTopics') ?? 10),
    includeExtensions: Array.isArray(exts) && exts.length > 0
      ? exts.map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean)
      : DEFAULT_INCLUDE_EXTENSIONS,
    maxFileBytes: Math.max(1024, cfg.get<number>('maxFileBytes') ?? 120_000),
    outputDir: (cfg.get<string>('outputDir') ?? '.quickcode').trim() || '.quickcode',
    endpoint: (cfg.get<string>('endpoint') ?? '').trim(),
    model: (cfg.get<string>('model') ?? '').trim(),
    temperature: typeof cfg.get<number>('temperature') === 'number'
      ? (cfg.get<number>('temperature') as number)
      : NaN,
    contextWindow: cfg.get<number>('contextWindow') ?? 0,
    perFileTimeoutMs: Math.max(15_000, cfg.get<number>('perFileTimeoutMs') ?? 180_000),
    runGeneratedTests: cfg.get<boolean>('runGeneratedTests') ?? false,
    testRunTimeoutMs: Math.max(5_000, cfg.get<number>('testRunTimeoutMs') ?? 60_000)
  };
}

function resolveLLMConfig(bg: BackgroundConfig): LLMConfig {
  const endpoints = readEndpoints();
  const ep = (bg.endpoint && endpoints.find((e) => e.name === bg.endpoint)) || getActiveEndpoint();
  const chatActive = readLLMConfig();
  const model = bg.model || ep.models[0] || chatActive.model;
  return {
    baseURL: ep.baseURL,
    apiKey: ep.apiKey,
    model,
    temperature: Number.isFinite(bg.temperature) ? bg.temperature : ep.temperature,
    contextWindow: bg.contextWindow > 0 ? bg.contextWindow : ep.contextWindow,
    allowSelfSignedCerts: ep.allowSelfSignedCerts
  };
}

/* ------------------------------------------------------------------ */
/* On-disk state                                                       */
/* ------------------------------------------------------------------ */

interface FileState {
  hash: string;
  lastProcessedAt: number;
  bugs: number;
  uncertainties: number;
  /** Detect schema upgrades. */
  version: number;
}

interface TopicState {
  id: string;
  title: string;
  rationale: string;
  hints: string[];
  status: 'pending' | 'done' | 'skipped' | 'error';
  /** Last time this topic was analysed / changed status. */
  updatedAt?: number;
  /** Workspace-relative file paths the agent reported reading. */
  filesExamined?: string[];
  /** How many bugs / tests this topic produced. */
  bugs?: number;
  uncertainties?: number;
  /** Last error message if status === 'error'. */
  lastError?: string;
  /** Number of failed attempts so far. Used to bound retries. */
  attempts?: number;
}

interface ExplorerState {
  files: Record<string, FileState>;
  lastCycleAt?: number;
  cyclesCompleted?: number;
  filesProcessed?: number;
  bugsFound?: number;
  testsGenerated?: number;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  testsSkipped?: number;
  /** Newest-first ring buffer of recent activity entries shown in README. */
  activityTail?: ActivityEntry[];
  /** Project-level brief produced by the planner. Empty until first plan. */
  brief?: string;
  /** Investigation backlog produced by the planner + user manual additions. */
  topics?: TopicState[];
  /** Hash of the workspace top-level layout that produced the current brief.
   *  When the layout changes significantly we trigger a re-plan. */
  briefLayoutHash?: string;
}

interface ActivityEntry {
  ts: number;
  phase: ExplorerPhase | 'event';
  message: string;
}

const STATE_VERSION = 1;
const ACTIVITY_TAIL_MAX = 50;

/* ------------------------------------------------------------------ */
/* Status reporting                                                    */
/* ------------------------------------------------------------------ */

export type ExplorerPhase =
  | 'disabled'
  | 'idle-waiting'
  | 'running'
  | 'paused-by-activity'
  | 'paused-by-chat'
  | 'no-workspace'
  | 'error';

export interface ExplorerStatus {
  phase: ExplorerPhase;
  detail: string;
  filesProcessed: number;
  bugsFound: number;
  testsGenerated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
  currentFile?: string;
  /** Currently active investigation topic (when topic-driven cycle is running). */
  currentTopic?: { id: string; title: string };
  modelLabel?: string;
  /** Most recent activity entries (newest first), capped to ~20 items for the UI. */
  recentActivity: ActivityEntry[];
}

/* ------------------------------------------------------------------ */
/* The explorer                                                        */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 5_000;
/** Max attempts per topic before we mark it `error` and stop retrying. */
const MAX_TOPIC_ATTEMPTS = 3;

export class BackgroundExplorer implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private cfg: BackgroundConfig;
  private pollHandle?: NodeJS.Timeout;
  /**
   * Cancellation tokens for every in-flight LLM operation in the current
   * cycle (planner + each parallel topic agent). All entries are cancelled
   * together when the user becomes active or the explorer is stopped.
   */
  private currentRuns = new Set<vscode.CancellationTokenSource>();
  /** Topics currently being investigated in parallel (id → short label). */
  private activeTopics = new Map<string, { id: string; title: string }>();
  /** Serialises appends to bugs.md so concurrent topics don't interleave writes. */
  private bugsAppendChain: Promise<void> = Promise.resolve();
  /**
   * Set to true while a cycle's worker pool should stop launching new
   * topics (cancellation, stop, or dispose). Reset at the top of each cycle.
   */
  private cycleAborted = false;
  /** Last user activity timestamp (typing, selection change, chat finishing). */
  private lastActivityAt = Date.now();
  /** Last completed cycle timestamp. Used to enforce minIntervalMs. */
  private lastCycleAt = 0;
  private inFlight = false;
  private statusEmitter = new vscode.EventEmitter<ExplorerStatus>();
  private status: ExplorerStatus = {
    phase: 'disabled',
    detail: 'Background explorer is disabled.',
    filesProcessed: 0,
    bugsFound: 0,
    testsGenerated: 0,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    recentActivity: []
  };
  private readonly output: vscode.OutputChannel;
  /** In-memory ring buffer of recent activity (newest last for log readers). */
  private activityTail: ActivityEntry[] = [];

  readonly onDidChangeStatus: vscode.Event<ExplorerStatus> = this.statusEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly chat: ChatViewProvider,
    private readonly workspaceIndex: WorkspaceIndex,
    private readonly hunkApplier: HunkApplier
  ) {
    this.cfg = readConfig();
    this.output = vscode.window.createOutputChannel('QuickCode Background');
    this.disposables.push(this.output);

    // Only real text edits are treated as IDE activity here. Cursor movement,
    // editor focus, and window focus are intentionally ignored because VS Code
    // emits them frequently while the user is merely reading, which would
    // otherwise cancel background analysis immediately after it starts.
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.handleTextDocumentChange(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('quickcode.background')) {
          const wasEnabled = this.cfg.enabled;
          this.cfg = readConfig();
          if (this.cfg.enabled && !wasEnabled) this.start();
          else if (!this.cfg.enabled && wasEnabled) this.stop();
          else this.publishStatus();
        }
      })
    );

    if (this.cfg.enabled) this.start();
  }

  /* ------------------------ public API --------------------------- */

  start(): void {
    if (this.pollHandle) return;
    this.cfg = readConfig();
    if (!vscode.workspace.workspaceFolders?.length) {
      this.setPhase('no-workspace', 'No workspace folder open.');
      return;
    }
    this.lastActivityAt = Date.now();
    this.pollHandle = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.setPhase('idle-waiting', `Will start after ${Math.round(this.cfg.idleThresholdMs / 1000)}s of inactivity.`);
    this.logger.info('BackgroundExplorer started.');
  }

  stop(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.cancelAllRuns();
    this.inFlight = false;
    this.setPhase('disabled', 'Background explorer is disabled.');
    this.logger.info('BackgroundExplorer stopped.');
  }

  /** Force a single cycle now (ignoring the idle gate). Useful for the runOnce command. */
  async runOnce(): Promise<void> {
    if (this.inFlight) {
      vscode.window.showInformationMessage('QuickCode: background analysis already in progress.');
      return;
    }
    if (this.chat.isBusy()) {
      vscode.window.showWarningMessage('QuickCode: chat is busy — background run skipped.');
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage('QuickCode: open a workspace folder first.');
      return;
    }
    this.cfg = readConfig();
    await this.runCycle(true);
  }

  /**
   * Called by the chat host whenever a user prompt / LLM response / tool-call
   * sequence is active. This counts as foreground activity: cancel any
   * background work immediately and restart the idle countdown from now.
   */
  notifyForegroundActivity(reason: string): void {
    this.markActivity(reason);
  }

  /** Mark current state file processed=hash so we re-analyse on next cycle. */
  async resetState(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const stateUri = this.stateFileUri(root);
    try {
      await vscode.workspace.fs.delete(stateUri);
    } catch {
      /* ignore */
    }
    this.status = {
      ...this.status,
      filesProcessed: 0,
      bugsFound: 0,
      testsGenerated: 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      testsSkipped: 0,
      recentActivity: [],
      currentTopic: undefined
    };
    this.activityTail = [];
    this.activity('event', 'State reset by user — project brief and topic backlog will rebuild on next cycle.');
    this.publishStatus();
    vscode.window.showInformationMessage('QuickCode: background analysis state cleared.');
  }

  getStatus(): ExplorerStatus {
    return this.status;
  }

  /** Reveal the live OutputChannel. Used by the "Show Activity Log" command. */
  showOutput(): void {
    this.output.show(true);
  }

  dispose(): void {
    this.stop();
    this.statusEmitter.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /* ------------------------ idle / scheduling -------------------- */

  private handleTextDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    if (e.document.uri.scheme !== 'file') return;
    // Ignore writes we make ourselves to the output directory.
    if (this.isOurOutputUri(e.document.uri)) return;
    // VS Code may fire document-change events for disk refreshes or extension
    // side effects. A genuine user edit normally makes the document dirty; if
    // it is not dirty, do not treat it as foreground activity.
    if (!e.document.isDirty) return;
    const root = this.workspaceRoot();
    const rel = root ? path.relative(root, e.document.uri.fsPath).replace(/\\/g, '/') : e.document.uri.fsPath;
    this.markActivity(`text-change:${rel}`);
  }

  private markActivity(_reason: string): void {
    this.lastActivityAt = Date.now();
    // If a background analysis is in flight, cancel it: the user is back.
    this.pauseCurrentRun(_reason);
  }

  private pauseCurrentRun(reason: string): void {
    if (this.currentRuns.size === 0) return;
    this.logger.debug(`BackgroundExplorer: cancelling ${this.currentRuns.size} in-flight analysis run(s) (${reason}).`);
    this.cancelAllRuns();
    this.setPhase('paused-by-activity', `Paused — foreground activity (${reason}).`);
  }

  /** Cancel and forget every tracked run; safe to call multiple times. */
  private cancelAllRuns(): void {
    // Stop the per-cycle worker pool from spawning further topics. Without
    // this flag, in-flight topics that are mid-cancellation would resolve
    // and the pump would happily launch fresh, uncancelled successors.
    this.cycleAborted = true;
    for (const cts of this.currentRuns) {
      try { cts.cancel(); } catch { /* ignore */ }
    }
    this.currentRuns.clear();
  }

  /** Serialise appends to a shared markdown log so parallel topics can't interleave. */
  private queueBugsAppend(absPath: string, contents: string): Promise<void> {
    const next = this.bugsAppendChain.then(() => appendFileSafe(absPath, contents)).catch((err) => {
      this.logger.warn('BackgroundExplorer: bugs.md append failed', String(err));
    });
    this.bugsAppendChain = next;
    return next;
  }

  private tick(): void {
    if (!this.cfg.enabled) return;
    if (this.inFlight) return;

    if (this.chat.isBusy()) {
      this.setPhase('paused-by-chat', 'Paused — chat request in progress.');
      // While chat is running we count it as activity so we keep waiting after.
      this.lastActivityAt = Date.now();
      return;
    }

    const now = Date.now();
    const idleFor = now - this.lastActivityAt;
    if (idleFor < this.cfg.idleThresholdMs) {
      const remaining = Math.ceil((this.cfg.idleThresholdMs - idleFor) / 1000);
      this.setPhase('idle-waiting', `Resuming in ~${remaining}s of continued inactivity.`);
      return;
    }
    if (now - this.lastCycleAt < this.cfg.minIntervalMs) {
      this.setPhase('idle-waiting', 'Cooling down between cycles…');
      return;
    }

    void this.runCycle(false);
  }

  /* ------------------------ cycle -------------------------------- */

  private async runCycle(force: boolean): Promise<void> {
    this.inFlight = true;
    try {
      const root = this.workspaceRoot();
      if (!root) {
        this.setPhase('no-workspace', 'No workspace folder open.');
        return;
      }
      const state = await this.loadState(root);
      const llm = resolveLLMConfig(this.cfg);
      this.status.modelLabel = `${displayEndpoint(llm.baseURL)} · ${llm.model}`;
      // Sync persisted counters into the live status so the status bar tooltip
      // and chat panel show the lifetime totals, not just this-cycle deltas.
      this.status.filesProcessed = state.filesProcessed ?? 0;
      this.status.bugsFound = state.bugsFound ?? 0;
      this.status.testsGenerated = state.testsGenerated ?? 0;
      this.status.testsRun = state.testsRun ?? 0;
      this.status.testsPassed = state.testsPassed ?? 0;
      this.status.testsFailed = state.testsFailed ?? 0;
      this.status.testsSkipped = state.testsSkipped ?? 0;
      this.activity('event', `Cycle starting — model ${llm.model} @ ${displayEndpoint(llm.baseURL)}.`);

      // Phase 1: ensure we have a project brief + topic backlog. The planner
      // also re-runs when the top-level workspace layout changes materially.
      const layoutHash = await this.computeLayoutHash(root);
      const needsBrief =
        !state.brief ||
        !state.topics ||
        state.topics.length === 0 ||
        state.briefLayoutHash !== layoutHash;
      if (needsBrief) {
        const planned = await this.planProjectBriefAndTopics(root, state, llm, layoutHash);
        if (!planned) {
          // Cancelled or error already reported via setPhase/activity. Bail out
          // of this cycle so we retry on the next idle window.
          return;
        }
      }

      // Phase 2: drain the pending-topic backlog with a sliding worker pool.
      // We keep up to `concurrency` `analyseTopic` calls in flight at all
      // times: as soon as one finishes, the next pending topic is launched
      // immediately rather than waiting for the whole batch to complete.
      const concurrency = Math.max(1, this.cfg.maxConcurrentTopics);
      this.cycleAborted = false;
      // Topics already handed to a worker in this cycle. Prevents two workers
      // from racing on the same topic before its status flips off `pending`.
      const claimed = new Set<string>();
      const claimNext = (): TopicState | undefined => {
        if (this.cycleAborted) return undefined;
        for (const t of state.topics ?? []) {
          if (t.status === 'pending' && !claimed.has(t.id)) {
            claimed.add(t.id);
            return t;
          }
        }
        return undefined;
      };
      let didTopicWork = false;
      let firstClaimed: TopicState | undefined;
      let totalLaunched = 0;
      await new Promise<void>((resolve) => {
        let inFlight = 0;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        const pump = () => {
          while (!this.cycleAborted && inFlight < concurrency) {
            const t = claimNext();
            if (!t) break;
            if (!firstClaimed) firstClaimed = t;
            totalLaunched++;
            inFlight++;
            void this.analyseTopic(root, t, state, llm)
              .then((ok) => { if (ok) didTopicWork = true; })
              .catch((err) => {
                this.logger.warn('BackgroundExplorer: analyseTopic threw', String(err));
              })
              .finally(() => {
                inFlight--;
                pump();
              });
          }
          if (inFlight === 0) finish();
        };
        pump();
      });

      if (totalLaunched === 0) {
        // No pending topics left → idle so the planner can produce more on a
        // future structural change (or the user can add manual topics).
        this.setPhase('idle-waiting', 'All planned topics analysed. Waiting for new code or user-added topics.');
      }

      this.lastCycleAt = Date.now();
      state.lastCycleAt = this.lastCycleAt;
      state.cyclesCompleted = (state.cyclesCompleted ?? 0) + 1;
      await this.saveState(root, state);

      // Single README aggregation for the whole cycle, after all parallel
      // topics have finished. Keeping it here (instead of inside analyseTopic)
      // is what makes the parallel writes safe.
      if (didTopicWork) {
        const outDir = path.join(root, this.cfg.outputDir);
        await writeFileSafe(
          path.join(outDir, 'README.md'),
          renderIndexReadme(state, this.cfg, llm, this.activityTail)
        );
      }

      if (didTopicWork && firstClaimed) {
        const remaining = (state.topics ?? []).filter((t) => t.status === 'pending').length;
        const headTitle = totalLaunched === 1
          ? truncate(firstClaimed.title, 80)
          : `${totalLaunched} topics (incl. ${truncate(firstClaimed.title, 60)})`;
        this.setPhase(
          'idle-waiting',
          `Topic done: ${headTitle} — ${remaining} topic${remaining === 1 ? '' : 's'} remaining.`
        );
      }
    } catch (err) {
      this.logger.error('BackgroundExplorer cycle failed', String(err));
      this.setPhase('error', `Cycle failed: ${truncate(String(err), 160)}`);
    } finally {
      this.inFlight = false;
    }
  }

  /* ------------------------ planner (brief + topics) ------------ */

  /**
   * Cheap hash of the workspace's top-level layout (top-level files +
   * directories, depth=1). When this changes between cycles we treat the
   * project structure as having shifted enough to be worth re-planning.
   */
  private async computeLayoutHash(root: string): Promise<string> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
      const filtered = entries
        .filter(([name]) => !name.startsWith('.') || name === '.github')
        .filter(([name]) => name !== this.cfg.outputDir)
        .map(([name, kind]) => `${kind === vscode.FileType.Directory ? 'd' : 'f'}:${name}`)
        .sort();
      return crypto.createHash('sha1').update(filtered.join('\n')).digest('hex').slice(0, 16);
    } catch {
      return '';
    }
  }

  /**
   * Read a small set of "high-signal" files at the workspace root that help
   * the planner understand the project shape (toolchain, entry points, docs).
   * Each file is capped to ~16KB; missing files are silently skipped.
   */
  private async loadKeyFilesForBrief(root: string): Promise<Array<{ relPath: string; contents: string }>> {
    const candidates = [
      'package.json', 'pnpm-workspace.yaml', 'tsconfig.json',
      'pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg',
      'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
      'Gemfile', 'composer.json',
      'README.md', 'README.rst', 'README.txt', 'README',
      'ARCHITECTURE.md', 'CONTRIBUTING.md',
      'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.py',
      'src/extension.ts', 'src/app.ts', 'src/server.ts'
    ];
    const out: Array<{ relPath: string; contents: string }> = [];
    for (const rel of candidates) {
      try {
        const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, rel)));
        if (buf.byteLength === 0 || buf.byteLength > 64 * 1024) continue;
        const probe = buf.slice(0, Math.min(4096, buf.byteLength));
        if (probe.includes(0)) continue;
        out.push({ relPath: rel, contents: Buffer.from(buf).toString('utf8') });
      } catch {
        /* missing — skip */
      }
    }
    return out;
  }

  /**
   * Build the project brief and initial topic backlog with a single LLM call.
   * Persists to `state.brief` / `state.topics` and writes a human-readable
   * `project-brief.md`. Returns false if the call was cancelled or failed
   * irrecoverably.
   */
  private async planProjectBriefAndTopics(
    root: string,
    state: ExplorerState,
    llm: LLMConfig,
    layoutHash: string
  ): Promise<boolean> {
    this.setPhase('running', 'Planning: building project brief and topic backlog…');

    const cts = new vscode.CancellationTokenSource();
    this.currentRuns.add(cts);
    const timeout = setTimeout(() => cts.cancel(), this.cfg.perFileTimeoutMs);
    try {
      const outline = (await this.workspaceIndex.getOutline().catch(() => undefined))?.text ?? '';
      const keyFiles = await this.loadKeyFilesForBrief(root);
      const messages: ChatMessage[] = [
        { role: 'system', content: BACKGROUND_BRIEF_PROMPT },
        {
          role: 'user',
          content: buildBriefUserMessage({ workspaceOutline: outline, keyFiles })
        }
      ];

      const client = new OpenAIClient(llm, this.logger);
      let raw = '';
      try {
        for await (const chunk of client.streamChat(messages, [], cts.token)) {
          if (chunk.contentDelta) raw += chunk.contentDelta;
        }
      } catch (err) {
        if (cts.token.isCancellationRequested) {
          this.activity('event', 'Planner cancelled before completion.');
          return false;
        }
        this.activity('error', `Planner LLM error: ${truncate(String(err), 200)}`);
        return false;
      }
      if (cts.token.isCancellationRequested) {
        this.activity('event', 'Planner cancelled after stream.');
        return false;
      }

      const plan = parseBriefAndTopics(raw);
      if (!plan) {
        this.activity('error', 'Planner output was not valid JSON; will retry next cycle.');
        return false;
      }

      // Merge topics: keep done/skipped status from prior plan when ids match,
      // append new ones, drop nothing the user has already worked on.
      const existing = new Map<string, TopicState>();
      for (const t of state.topics ?? []) existing.set(t.id, t);
      const merged: TopicState[] = [];
      for (const t of plan.topics) {
        const prior = existing.get(t.id);
        merged.push({
          id: t.id,
          title: t.title,
          rationale: t.rationale,
          hints: t.hints,
          status: prior?.status ?? 'pending',
          updatedAt: prior?.updatedAt,
          filesExamined: prior?.filesExamined,
          bugs: prior?.bugs,
          uncertainties: prior?.uncertainties,
          lastError: prior?.lastError
        });
      }
      // Preserve prior topics that the new plan dropped (user manual ones, etc.).
      for (const t of state.topics ?? []) {
        if (!merged.find((m) => m.id === t.id)) merged.push(t);
      }

      state.brief = plan.brief;
      state.topics = merged;
      state.briefLayoutHash = layoutHash;
      await writeFileSafe(
        path.join(root, this.cfg.outputDir, 'project-brief.md'),
        renderProjectBriefMarkdown(plan.brief, merged)
      );
      this.activity(
        'event',
        `Planner produced ${plan.topics.length} topic${plan.topics.length === 1 ? '' : 's'}; ${merged.filter((t) => t.status === 'pending').length} pending.`
      );
      return true;
    } finally {
      clearTimeout(timeout);
      cts.dispose();
      this.currentRuns.delete(cts);
    }
  }

  /* ------------------------ topic investigation ------------------ */

  /**
   * Run a single topic through an `AgentLoop` with read-only tools so the
   * model can pull whichever files it needs. The final assistant message is
   * expected to be a JSON object matching the topic-investigation schema;
   * we parse it, write outputs, and update the topic's status.
   */
  private async analyseTopic(
    root: string,
    topic: TopicState,
    state: ExplorerState,
    llm: LLMConfig
  ): Promise<boolean> {
    this.activeTopics.set(topic.id, { id: topic.id, title: topic.title });
    this.refreshRunningPhase();

    const cts = new vscode.CancellationTokenSource();
    this.currentRuns.add(cts);
    // Topic investigations may need several tool calls; give them a generous
    // multiplier of the per-file timeout so a slow grep doesn't kill the run.
    const timeout = setTimeout(() => cts.cancel(), this.cfg.perFileTimeoutMs * 4);

    try {
      const client = new OpenAIClient(llm, this.logger);
      const tools = [readFileTool, listDirTool, grepSearchTool, workspaceOutlineTool];
      const agent = new AgentLoop(client, tools, this.hunkApplier, this.logger, {
        contextWindow: llm.contextWindow,
        maxIterations: 12,
        requireConfirmBeforeEdit: true,
        autoContinueOnLength: true,
        maxAutoContinues: 2,
        systemPrompt: BACKGROUND_TOPIC_SYSTEM_PROMPT
      });

      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: buildTopicUserMessage({
            topicId: topic.id,
            topicTitle: topic.title,
            topicRationale: topic.rationale,
            topicHints: topic.hints,
            brief: state.brief ?? ''
          })
        }
      ];

      // Drive one pass of the agent loop and report the last assistant text.
      // We hoist this into a local closure so we can re-run it after a
      // self-repair turn without duplicating the event-handling boilerplate.
      let toolCallCount = 0;
      const drive = async (): Promise<{ text: string; cancelled: boolean; error?: string }> => {
        let lastText = '';
        try {
          for await (const ev of agent.run(messages, cts.token)) {
            if (cts.token.isCancellationRequested) break;
            if (ev.type === 'assistant-message') {
              const payload = ev.payload as { text?: string; toolCalls?: number };
              if (payload?.text) lastText = payload.text;
              if (typeof payload?.toolCalls === 'number') toolCallCount += payload.toolCalls;
            } else if (ev.type === 'error') {
              this.activity('error', `Topic agent error on ${topic.id}: ${truncate(String(ev.payload), 200)}`);
            }
          }
        } catch (err) {
          if (cts.token.isCancellationRequested) return { text: lastText, cancelled: true };
          return { text: lastText, cancelled: false, error: String(err) };
        }
        return { text: lastText, cancelled: cts.token.isCancellationRequested };
      };

      let result = await drive();
      if (result.cancelled) {
        this.activity('event', `Topic cancelled: ${topic.id}`);
        return false;
      }
      if (result.error) {
        this.recordTopicFailure(state, topic, `agent error: ${truncate(result.error, 200)}`);
        return false;
      }

      let parsed = parseTopicResult(result.text);
      if (!parsed) {
        // Self-repair turn: ask the model — within the same conversation —
        // to re-emit the report as a strict JSON object. This is much
        // cheaper than a full retry on the next cycle because the agent
        // has already paid the cost of pulling files into context.
        this.activity('event', `Topic ${topic.id}: first reply unparseable; requesting JSON-only resend.`);
        messages.push({
          role: 'user',
          content:
            'Your previous reply could not be parsed as JSON. Re-emit the FINAL report as a SINGLE JSON object only — no prose, no markdown fences, no commentary. The JSON must match the schema given in the system prompt (skip, summary, doc, files_examined, bugs[], uncertainties[]). Do not call any tools; just return the JSON.'
        });
        const retry = await drive();
        if (retry.cancelled) {
          this.activity('event', `Topic cancelled during repair: ${topic.id}`);
          return false;
        }
        if (retry.error) {
          this.recordTopicFailure(state, topic, `agent error during repair: ${truncate(retry.error, 200)}`);
          return false;
        }
        parsed = parseTopicResult(retry.text);
        if (!parsed) {
          this.recordTopicFailure(state, topic, 'agent returned no parseable JSON (after repair turn)');
          return false;
        }
      }

      const outDir = path.join(root, this.cfg.outputDir);
      // Per-topic markdown report.
      await writeFileSafe(
        path.join(outDir, 'topics', `${topic.id}.md`),
        renderTopicReportMarkdown(topic, parsed)
      );
      // Append cross-file bugs to the rolling bugs.md. Funnelled through a
      // serial chain so parallel topics never interleave their writes.
      if (parsed.bugs.length > 0) {
        await this.queueBugsAppend(
          path.join(outDir, 'bugs.md'),
          renderTopicBugsMarkdown(topic, parsed)
        );
      }
      // Materialise generated tests under a topic-scoped folder.
      const writtenTests: Array<{ absPath: string; language: string; topic: string }> = [];
      if (parsed.uncertainties.some((u: AnalysisUncertainty) => u.language?.toLowerCase().startsWith('py'))) {
        await ensurePyConftest(outDir);
      }
      for (const u of parsed.uncertainties) {
        const fname = sanitiseFilename(u.filename) || defaultTopicTestFilename(topic.id, u.language);
        const testPath = path.join(outDir, 'tests', topic.id, fname);
        await writeFileSafe(testPath, renderTestFileForTopic(topic, u));
        writtenTests.push({ absPath: testPath, language: u.language, topic: u.topic || topic.title });
      }

      // Update topic status and aggregate counters.
      topic.status = parsed.skip ? 'skipped' : 'done';
      topic.updatedAt = Date.now();
      topic.filesExamined = parsed.files_examined.slice(0, 50);
      topic.bugs = parsed.bugs.length;
      topic.uncertainties = parsed.uncertainties.length;
      topic.lastError = undefined;

      state.bugsFound = (state.bugsFound ?? 0) + parsed.bugs.length;
      state.testsGenerated = (state.testsGenerated ?? 0) + parsed.uncertainties.length;
      this.status.bugsFound = state.bugsFound ?? 0;
      this.status.testsGenerated = state.testsGenerated ?? 0;

      this.activity(
        'event',
        `Topic ${topic.id}: ${parsed.skip ? 'skipped' : 'done'} — ${parsed.files_examined.length} file${parsed.files_examined.length === 1 ? '' : 's'} read, ${parsed.bugs.length} bug${parsed.bugs.length === 1 ? '' : 's'}, ${parsed.uncertainties.length} test${parsed.uncertainties.length === 1 ? '' : 's'}, ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}.`
      );

      // Auto-run generated tests when configured.
      if (this.cfg.runGeneratedTests && writtenTests.length > 0) {
        await this.runAndRecordTests(root, topic.id, writtenTests, state);
      } else if (writtenTests.length > 0) {
        this.activity('event', `Auto-run disabled — review tests under ${path.posix.join(this.cfg.outputDir, 'tests', topic.id)}/.`);
      }

      // README aggregation is now done once at the end of the cycle so
      // concurrent topics never race on writing the same file.
      return true;
    } finally {
      clearTimeout(timeout);
      cts.dispose();
      this.currentRuns.delete(cts);
      this.activeTopics.delete(topic.id);
      this.refreshRunningPhase();
    }
  }

  /**
   * Re-broadcast the "running" phase based on the live `activeTopics` map.
   * When several topics are in flight we report the count plus the most
   * recently added title; when none remain we leave the phase untouched
   * (the cycle driver will move it to `idle-waiting`).
   */
  private refreshRunningPhase(): void {
    if (this.activeTopics.size === 0) {
      this.status.currentTopic = undefined;
      this.publishStatus();
      return;
    }
    const topics = Array.from(this.activeTopics.values());
    const head = topics[topics.length - 1];
    this.status.currentTopic = { id: head.id, title: head.title };
    const detail = topics.length === 1
      ? `Investigating topic: ${truncate(head.title, 100)}`
      : `Investigating ${topics.length} topics in parallel — latest: ${truncate(head.title, 80)}`;
    this.setPhase('running', detail);
  }

  /**
   * Record a topic-investigation failure. Up to `MAX_TOPIC_ATTEMPTS - 1`
   * retries the topic stays `pending` but is rotated to the end of the queue
   * so other topics get a turn first; after that it's marked `error` and the
   * scheduler skips it until the user resets state or re-plans.
   */
  private recordTopicFailure(state: ExplorerState, topic: TopicState, reason: string): void {
    const attempts = (topic.attempts ?? 0) + 1;
    topic.attempts = attempts;
    topic.lastError = reason.slice(0, 400);
    topic.updatedAt = Date.now();
    if (attempts >= MAX_TOPIC_ATTEMPTS) {
      topic.status = 'error';
      this.activity('error', `Topic ${topic.id} failed after ${attempts} attempt${attempts === 1 ? '' : 's'} — giving up: ${reason}`);
    } else {
      topic.status = 'pending';
      // Move the failing topic to the back of the backlog so we make
      // progress on others before retrying the same broken one.
      if (state.topics) {
        const idx = state.topics.findIndex((t) => t.id === topic.id);
        if (idx >= 0) {
          state.topics.splice(idx, 1);
          state.topics.push(topic);
        }
      }
      this.activity('event', `Topic ${topic.id} failed (attempt ${attempts}/${MAX_TOPIC_ATTEMPTS}); will retry later — ${reason}`);
    }
  }

  private async analyseFile(
    root: string,
    file: { absPath: string; relPath: string; contents: string; hash: string },
    state: ExplorerState,
    llm: LLMConfig
  ): Promise<boolean> {
    this.setPhase('running', `Analysing ${file.relPath}`, file.relPath);

    const cts = new vscode.CancellationTokenSource();
    this.currentRuns.add(cts);
    const timeout = setTimeout(() => cts.cancel(), this.cfg.perFileTimeoutMs);

    try {
      const language = languageForExtension(path.extname(file.relPath));
      const outline = (await this.workspaceIndex.getOutline().catch(() => undefined))?.text;
      const importSpecifier = computeImportSpecifier(file.relPath, this.cfg.outputDir);
      const messages: ChatMessage[] = [
        { role: 'system', content: BACKGROUND_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildAnalysisUserMessage({
            relativePath: file.relPath.replace(/\\/g, '/'),
            language,
            contents: file.contents,
            workspaceOutline: outline,
            importSpecifier
          })
        }
      ];

      const startedAt = Date.now();
      const client = new OpenAIClient(llm, this.logger);
      let raw = '';
      try {
        for await (const chunk of client.streamChat(messages, [], cts.token)) {
          if (chunk.contentDelta) raw += chunk.contentDelta;
        }
      } catch (err) {
        if (cts.token.isCancellationRequested) {
          this.activity('event', `Analysis cancelled mid-stream: ${file.relPath}`);
          return false;
        }
        this.logger.warn(`BackgroundExplorer LLM error on ${file.relPath}`, String(err));
        this.activity('error', `LLM error on ${file.relPath}: ${truncate(String(err), 200)}`);
        return false;
      }

      if (cts.token.isCancellationRequested) {
        this.activity('event', `Analysis cancelled after stream: ${file.relPath}`);
        return false;
      }

      const elapsedMs = Date.now() - startedAt;
      const parsed = parseAnalysis(raw);
      if (!parsed) {
        this.activity('error', `Could not parse JSON for ${file.relPath} (LLM did not follow schema).`);
        // Still mark processed so we don't loop on a model that won't comply.
      }

      // Persist outputs.
      const outDir = path.join(root, this.cfg.outputDir);
      let bugCount = 0;
      let testCount = 0;
      const writtenTests: Array<{ absPath: string; language: string; topic: string }> = [];
      if (parsed && !parsed.skip) {
        await writeFileSafe(
          path.join(outDir, 'docs', file.relPath + '.md'),
          renderDocMarkdown(file.relPath, parsed)
        );
        if (parsed.bugs.length > 0) {
          await this.queueBugsAppend(
            path.join(outDir, 'bugs.md'),
            renderBugsMarkdown(file.relPath, parsed)
          );
          bugCount = parsed.bugs.length;
          this.activity('event', `Recorded ${bugCount} suspected bug${bugCount === 1 ? '' : 's'} in ${file.relPath}.`);
        }
        // For Python projects, drop a conftest.py once so the auto-runner can
        // import workspace-rooted modules (e.g. `from src.foo import ...`).
        if (parsed.uncertainties.some((u) => u.language?.toLowerCase().startsWith('py'))) {
          await ensurePyConftest(outDir);
        }
        for (const u of parsed.uncertainties) {
          const fname = sanitiseFilename(u.filename) || defaultTestFilename(file.relPath, u.language);
          const testPath = path.join(outDir, 'tests', file.relPath + '.d', fname);
          await writeFileSafe(testPath, renderTestFile(file.relPath, u));
          writtenTests.push({ absPath: testPath, language: u.language, topic: u.topic });
          testCount++;
        }
        if (testCount > 0) {
          this.activity('event', `Generated ${testCount} test${testCount === 1 ? '' : 's'} for uncertainties in ${file.relPath}.`);
        }
      }

      this.activity(
        'event',
        `Analysed ${file.relPath} in ${(elapsedMs / 1000).toFixed(1)}s — ${bugCount} bug${bugCount === 1 ? '' : 's'}, ${testCount} test${testCount === 1 ? '' : 's'}.`
      );

      state.files[file.relPath] = {
        hash: file.hash,
        lastProcessedAt: Date.now(),
        bugs: bugCount,
        uncertainties: testCount,
        version: STATE_VERSION
      };
      state.filesProcessed = (state.filesProcessed ?? 0) + 1;
      state.bugsFound = (state.bugsFound ?? 0) + bugCount;
      state.testsGenerated = (state.testsGenerated ?? 0) + testCount;

      // Refresh aggregate counters in the live status.
      this.status.filesProcessed = state.filesProcessed;
      this.status.bugsFound = state.bugsFound;
      this.status.testsGenerated = state.testsGenerated ?? 0;

      // Auto-run generated tests when configured. Each result is recorded
      // both alongside the test file and in the rolling verifications log.
      if (this.cfg.runGeneratedTests && writtenTests.length > 0) {
        await this.runAndRecordTests(root, file.relPath, writtenTests, state);
      } else if (writtenTests.length > 0) {
        this.activity('event', `Auto-run disabled — review tests under ${path.posix.join(this.cfg.outputDir, 'tests', file.relPath.replace(/\\/g, '/') + '.d')}/.`);
      }

      // Update the index README + state at the end so partial failures still
      // leave on-disk artefacts consistent with state.json.
      await writeFileSafe(path.join(outDir, 'README.md'), renderIndexReadme(state, this.cfg, llm, this.activityTail));

      return true;
    } finally {
      clearTimeout(timeout);
      cts.dispose();
      this.currentRuns.delete(cts);
    }
  }

  /**
   * Execute each generated test file and write a per-test result file
   * (`<test>.result.md`), a workspace-level verifications log, and update
   * the state counters / live status accordingly.
   */
  private async runAndRecordTests(
    root: string,
    sourceRel: string,
    tests: Array<{ absPath: string; language: string; topic: string }>,
    state: ExplorerState
  ): Promise<void> {
    const outDir = path.join(root, this.cfg.outputDir);
    for (const t of tests) {
      // Each test gets its own pause check so a flurry of activity can
      // interrupt a long test sequence cleanly.
      if (this.chat.isBusy()) {
        this.activity('paused-by-chat', 'Skipping remaining test runs — chat became busy.');
        break;
      }
      const testRel = path.relative(root, t.absPath).replace(/\\/g, '/');
      this.setPhase('running', `Running test ${testRel}`, sourceRel);
      this.activity('event', `Executing ${testRel} (${t.language})…`);
      const result = await runGeneratedTest({
        root,
        testAbsPath: t.absPath,
        language: t.language,
        timeoutMs: this.cfg.testRunTimeoutMs
      });
      // Update counters.
      state.testsRun = (state.testsRun ?? 0) + 1;
      this.status.testsRun = state.testsRun;
      if (result.status === 'passed') {
        state.testsPassed = (state.testsPassed ?? 0) + 1;
        this.status.testsPassed = state.testsPassed;
      } else if (result.status === 'failed') {
        state.testsFailed = (state.testsFailed ?? 0) + 1;
        this.status.testsFailed = state.testsFailed;
      } else if (result.status === 'skipped') {
        state.testsSkipped = (state.testsSkipped ?? 0) + 1;
        this.status.testsSkipped = state.testsSkipped;
      }
      // Per-test result file.
      await writeFileSafe(t.absPath + '.result.md', renderTestResult(testRel, t.topic, result));
      // Verifications log (rolling, all tests).
      await appendFileSafe(
        path.join(outDir, 'verifications.md'),
        renderVerificationEntry(sourceRel, testRel, t.topic, result)
      );
      // Activity feed.
      const summary =
        result.status === 'passed'
          ? `pass (${result.durationMs}ms)`
          : result.status === 'failed'
            ? `FAIL (exit ${result.exitCode}, ${result.durationMs}ms)`
            : result.status === 'skipped'
              ? `skipped — ${result.reason}`
              : `error — ${result.reason}`;
      this.activity('event', `Test ${testRel}: ${summary}`);
    }
  }

  /* ------------------------ file scanning ------------------------ */

  private async pickNextFile(
    root: string,
    state: ExplorerState
  ): Promise<{ absPath: string; relPath: string; contents: string; hash: string } | undefined> {
    const candidates = await this.collectCandidates(root);
    // Process never-seen files first, then those whose hash changed, in
    // alphabetical order so progress is predictable.
    const fresh: typeof candidates = [];
    const changed: typeof candidates = [];
    for (const c of candidates) {
      const prior = state.files[c.relPath];
      if (!prior) fresh.push(c);
      else if (prior.hash !== c.hash) changed.push(c);
    }
    fresh.sort((a, b) => a.relPath.localeCompare(b.relPath));
    changed.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return fresh[0] ?? changed[0];
  }

  private async collectCandidates(
    root: string
  ): Promise<Array<{ absPath: string; relPath: string; contents: string; hash: string }>> {
    const out: Array<{ absPath: string; relPath: string; contents: string; hash: string }> = [];
    const excludeDirs = new Set([
      ...defaultOutlineOptions.excludeDirs,
      this.cfg.outputDir,
      '.quickcode'
    ]);
    const extraExcludes = vscode.workspace
      .getConfiguration('quickcode.context')
      .get<string[]>('outlineExtraExcludes');
    if (Array.isArray(extraExcludes)) extraExcludes.forEach((d) => excludeDirs.add(d));

    const includeExts = new Set(this.cfg.includeExtensions);
    const maxBytes = this.cfg.maxFileBytes;

    const walk = async (absDir: string, relDir: string): Promise<void> => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(absDir));
      } catch {
        return;
      }
      for (const [name, kind] of entries) {
        if (kind === vscode.FileType.Directory) {
          if (excludeDirs.has(name)) continue;
          if (name.startsWith('.') && relDir !== '') continue; // skip hidden subdirs (top level kept selectively)
          if (name.startsWith('.') && !['.github'].includes(name)) continue;
          await walk(path.join(absDir, name), relDir ? path.join(relDir, name) : name);
        } else if (kind === vscode.FileType.File) {
          const ext = path.extname(name).slice(1).toLowerCase();
          if (!includeExts.has(ext)) continue;
          const absPath = path.join(absDir, name);
          const relPath = relDir ? path.join(relDir, name) : name;
          let buf: Uint8Array;
          try {
            buf = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
          } catch {
            continue;
          }
          if (buf.byteLength === 0 || buf.byteLength > maxBytes) continue;
          // Cheap binary check: NUL byte in the first 4KB.
          const probe = buf.slice(0, Math.min(4096, buf.byteLength));
          if (probe.includes(0)) continue;
          const contents = Buffer.from(buf).toString('utf8');
          const hash = crypto.createHash('sha1').update(contents).digest('hex');
          out.push({ absPath, relPath, contents, hash });
        }
      }
    };

    await walk(root, '');
    return out;
  }

  /* ------------------------ persistence -------------------------- */

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private stateFileUri(root: string): vscode.Uri {
    return vscode.Uri.file(path.join(root, this.cfg.outputDir, 'state.json'));
  }

  private async loadState(root: string): Promise<ExplorerState> {
    const uri = this.stateFileUri(root);
    try {
      const buf = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
      if (parsed && typeof parsed === 'object' && parsed.files) {
        return {
          files: parsed.files,
          lastCycleAt: parsed.lastCycleAt,
          cyclesCompleted: parsed.cyclesCompleted ?? 0,
          filesProcessed: parsed.filesProcessed ?? 0,
          bugsFound: parsed.bugsFound ?? 0,
          testsGenerated: parsed.testsGenerated ?? 0,
          testsRun: parsed.testsRun ?? 0,
          testsPassed: parsed.testsPassed ?? 0,
          testsFailed: parsed.testsFailed ?? 0,
          testsSkipped: parsed.testsSkipped ?? 0,
          brief: typeof parsed.brief === 'string' ? parsed.brief : undefined,
          topics: Array.isArray(parsed.topics) ? sanitizeTopics(parsed.topics) : undefined,
          briefLayoutHash: typeof parsed.briefLayoutHash === 'string' ? parsed.briefLayoutHash : undefined
        };
      }
    } catch {
      /* missing → fresh state */
    }
    return { files: {}, cyclesCompleted: 0, filesProcessed: 0, bugsFound: 0, testsGenerated: 0 };
  }

  private async saveState(root: string, state: ExplorerState): Promise<void> {
    await writeFileSafe(
      path.join(root, this.cfg.outputDir, 'state.json'),
      JSON.stringify(state, null, 2)
    );
  }

  /* ------------------------ helpers ------------------------------ */

  private isOurOutputUri(uri: vscode.Uri): boolean {
    const root = this.workspaceRoot();
    if (!root) return false;
    const out = path.join(root, this.cfg.outputDir);
    const p = uri.fsPath;
    return p === out || p.startsWith(out + path.sep);
  }

  private setPhase(phase: ExplorerPhase, detail: string, currentFile?: string): void {
    const phaseChanged = this.status.phase !== phase;
    const detailChanged = this.status.detail !== detail;
    this.status = {
      ...this.status,
      phase,
      detail,
      currentFile
    };
    // Log every real state transition. Skip pure detail-only countdown
    // updates (idle-waiting → idle-waiting "remaining 47s …") so we don't
    // spam the OutputChannel.
    if (phaseChanged || (detailChanged && phase !== 'idle-waiting' && phase !== 'paused-by-chat')) {
      this.activity(phase, detail);
    }
    this.publishStatus();
  }

  /**
   * Record a single line of background activity. Goes to:
   *   1. The user-visible OutputChannel "QuickCode Background"
   *   2. The persistent `<outputDir>/activity.log` file (best-effort)
   *   3. The in-memory `activityTail` ring buffer (rendered into README)
   *   4. The status object (so the chat panel / status bar can display tail)
   */
  private activity(phase: ExplorerPhase | 'event', message: string): void {
    const ts = Date.now();
    const line = `[${new Date(ts).toISOString()}] [${phase}] ${message}`;
    this.output.appendLine(line);
    const entry: ActivityEntry = { ts, phase, message };
    this.activityTail.push(entry);
    if (this.activityTail.length > ACTIVITY_TAIL_MAX) {
      this.activityTail.splice(0, this.activityTail.length - ACTIVITY_TAIL_MAX);
    }
    // Newest-first slice for UI consumers.
    this.status.recentActivity = [...this.activityTail].reverse().slice(0, 20);

    // Append to disk asynchronously; ignore failures (e.g. read-only fs).
    const root = this.workspaceRoot();
    if (root) {
      const logPath = path.join(root, this.cfg.outputDir, 'activity.log');
      void appendFileSafe(logPath, line + '\n').catch(() => {
        /* ignore */
      });
    }
  }

  private publishStatus(): void {
    this.statusEmitter.fire(this.status);
  }
}

/* ------------------------------------------------------------------ */
/* JSON parsing                                                        */
/* ------------------------------------------------------------------ */

interface AnalysisBug {
  line: number | null;
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
}
interface AnalysisUncertainty {
  topic: string;
  rationale: string;
  language: string;
  framework: string;
  filename: string;
  test_code: string;
}
interface AnalysisResult {
  skip: boolean;
  summary: string;
  doc: string;
  bugs: AnalysisBug[];
  uncertainties: AnalysisUncertainty[];
}

function parseAnalysis(raw: string): AnalysisResult | undefined {
  if (!raw) return undefined;
  // Strip ```json fences if present, then locate the outermost JSON object.
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  const candidate = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const bugs: AnalysisBug[] = Array.isArray(o.bugs)
    ? o.bugs
        .map((b) => {
          if (!b || typeof b !== 'object') return undefined;
          const r = b as Record<string, unknown>;
          const sev = String(r.severity ?? 'low').toLowerCase();
          return {
            line: typeof r.line === 'number' ? r.line : null,
            severity: (sev === 'high' || sev === 'medium' ? sev : 'low') as AnalysisBug['severity'],
            title: String(r.title ?? '').slice(0, 200),
            description: String(r.description ?? '').slice(0, 4000)
          };
        })
        .filter((b): b is AnalysisBug => !!b && (!!b.title || !!b.description))
    : [];
  const uncertainties: AnalysisUncertainty[] = Array.isArray(o.uncertainties)
    ? o.uncertainties
        .map((u) => {
          if (!u || typeof u !== 'object') return undefined;
          const r = u as Record<string, unknown>;
          return {
            topic: String(r.topic ?? '').slice(0, 300),
            rationale: String(r.rationale ?? '').slice(0, 2000),
            language: String(r.language ?? '').toLowerCase(),
            framework: String(r.framework ?? ''),
            filename: String(r.filename ?? ''),
            test_code: String(r.test_code ?? '')
          };
        })
        .filter((u): u is AnalysisUncertainty => !!u && !!u.test_code)
    : [];
  return {
    skip: o.skip === true,
    summary: String(o.summary ?? '').slice(0, 2000),
    doc: String(o.doc ?? '').slice(0, 20000),
    bugs,
    uncertainties
  };
}

/* ------------------------------------------------------------------ */
/* Output rendering                                                    */
/* ------------------------------------------------------------------ */

function renderDocMarkdown(relPath: string, a: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`# ${relPath}`);
  lines.push('');
  lines.push(`_Generated by QuickCode background explorer at ${new Date().toISOString()}_`);
  lines.push('');
  if (a.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(a.summary.trim());
    lines.push('');
  }
  if (a.doc) {
    lines.push('## Details');
    lines.push('');
    lines.push(a.doc.trim());
    lines.push('');
  }
  if (a.bugs.length > 0) {
    lines.push('## Potential Issues');
    lines.push('');
    for (const b of a.bugs) {
      const where = b.line ? `line ${b.line}` : 'unspecified';
      lines.push(`- **[${b.severity.toUpperCase()}] ${b.title}** (${where}) — ${b.description}`);
    }
    lines.push('');
  }
  if (a.uncertainties.length > 0) {
    lines.push('## Uncertainties / Generated Tests');
    lines.push('');
    for (const u of a.uncertainties) {
      lines.push(`- **${u.topic}** — ${u.rationale} _(${u.language}/${u.framework})_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderBugsMarkdown(relPath: string, a: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`## ${relPath} — ${new Date().toISOString()}`);
  lines.push('');
  for (const b of a.bugs) {
    const where = b.line ? `line ${b.line}` : 'unspecified';
    lines.push(`- **[${b.severity.toUpperCase()}] ${b.title}** (${where})`);
    if (b.description) lines.push(`  - ${b.description.split('\n').join('\n    ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderTestFile(relPath: string, u: AnalysisUncertainty): string {
  const banner =
    `// QuickCode background-generated test for: ${relPath}\n` +
    `// Topic: ${u.topic}\n` +
    `// Rationale: ${u.rationale}\n` +
    `// Framework: ${u.framework}\n` +
    `// NOTE: this test was machine-generated for verification of an\n` +
    `// uncertainty; review and adjust imports/paths before running.\n\n`;
  const isPython = u.language.startsWith('py');
  const isGo = u.language === 'go';
  const commentBanner = isPython
    ? banner.replace(/^\/\//gm, '#')
    : isGo
      ? banner
      : banner;
  return commentBanner + u.test_code.trim() + '\n';
}

function renderIndexReadme(
  state: ExplorerState,
  cfg: BackgroundConfig,
  llm: LLMConfig,
  activityTail: ActivityEntry[]
): string {
  const lines: string[] = [];
  lines.push('# QuickCode Background Explorer');
  lines.push('');
  lines.push('This directory is maintained automatically by QuickCode while the');
  lines.push('IDE is idle. You can safely delete it; it will be regenerated.');
  lines.push('');
  lines.push('## Latest run');
  lines.push('');
  lines.push(`- Last cycle: ${state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : 'never'}`);
  lines.push(`- Cycles completed: ${state.cyclesCompleted ?? 0}`);
  lines.push(`- Files analysed: ${state.filesProcessed ?? 0}`);
  lines.push(`- Bugs flagged: ${state.bugsFound ?? 0}`);
  lines.push(`- Tests generated: ${state.testsGenerated ?? 0}`);
  lines.push(`- Tests run: ${state.testsRun ?? 0} (passed ${state.testsPassed ?? 0}, failed ${state.testsFailed ?? 0}, skipped ${state.testsSkipped ?? 0})`);
  lines.push(`- Auto-run tests: ${cfg.runGeneratedTests ? 'enabled' : 'disabled'}`);
  lines.push(`- Model: \`${llm.model}\` @ \`${llm.baseURL}\``);
  lines.push('');
  lines.push('## Layout');
  lines.push('');
  lines.push('- `docs/<source-path>.md` — per-file summary, design notes, hotspots');
  lines.push('- `bugs.md` — rolling log of suspected issues');
  lines.push('- `tests/<source-path>.d/` — auto-generated unit tests for uncertainties');
  lines.push('- `tests/<source-path>.d/<file>.result.md` — per-test execution result (when auto-run is on)');
  lines.push('- `verifications.md` — chronological log of every test run');
  lines.push('- `activity.log` — full timestamped activity log (also visible in the "QuickCode Background" output channel)');
  lines.push('- `state.json` — internal scheduler state (file hashes, counters)');
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push('- Toggle: `quickcode.background.enabled`');
  lines.push('- Idle threshold (ms): `quickcode.background.idleThresholdMs`');
  lines.push(`- Endpoint override: \`${cfg.endpoint || '(use chat active)'}\``);
  lines.push(`- Model override: \`${cfg.model || '(use endpoint default)'}\``);
  lines.push(`- Auto-run generated tests: \`quickcode.background.runGeneratedTests\` (currently ${cfg.runGeneratedTests ? 'on' : 'off'})`);
  lines.push('');
  if (activityTail.length > 0) {
    lines.push('## Recent activity');
    lines.push('');
    // Newest first, capped to ~25 lines so the README stays readable.
    const tail = [...activityTail].reverse().slice(0, 25);
    for (const e of tail) {
      lines.push(`- \`${new Date(e.ts).toISOString()}\` _${e.phase}_ — ${e.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Per-test result file, dropped next to the generated test file. */
function renderTestResult(testRel: string, topic: string, result: TestRunResult): string {
  const lines: string[] = [];
  lines.push(`# Test result — ${testRel}`);
  lines.push('');
  lines.push(`_Generated by QuickCode background explorer at ${new Date().toISOString()}_`);
  lines.push('');
  lines.push(`- Status: **${result.status.toUpperCase()}**`);
  lines.push(`- Topic: ${topic}`);
  if (result.command) lines.push(`- Command: \`${result.command}\``);
  if (typeof result.exitCode === 'number') lines.push(`- Exit code: ${result.exitCode}`);
  if (typeof result.durationMs === 'number') lines.push(`- Duration: ${result.durationMs}ms`);
  if (result.reason) lines.push(`- Note: ${result.reason}`);
  lines.push('');
  if (result.output) {
    lines.push('## Output');
    lines.push('');
    lines.push('```');
    lines.push(result.output.trim());
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/** One block appended to verifications.md for each test run. */
function renderVerificationEntry(
  sourceRel: string,
  testRel: string,
  topic: string,
  result: TestRunResult
): string {
  const lines: string[] = [];
  const stamp = new Date().toISOString();
  lines.push(`### ${stamp} — ${result.status.toUpperCase()}`);
  lines.push('');
  lines.push(`- Source: \`${sourceRel}\``);
  lines.push(`- Test: \`${testRel}\``);
  lines.push(`- Topic: ${topic}`);
  if (result.command) lines.push(`- Command: \`${result.command}\``);
  if (typeof result.exitCode === 'number') lines.push(`- Exit code: ${result.exitCode}`);
  if (typeof result.durationMs === 'number') lines.push(`- Duration: ${result.durationMs}ms`);
  if (result.reason) lines.push(`- Note: ${result.reason}`);
  if (result.output && result.status !== 'passed') {
    // Only embed output for non-passing runs to keep the log readable.
    lines.push('');
    lines.push('<details><summary>Output</summary>');
    lines.push('');
    lines.push('```');
    lines.push(result.output.trim().slice(0, 4000));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

async function writeFileSafe(absPath: string, contents: string): Promise<void> {
  const uri = vscode.Uri.file(absPath);
  const dir = vscode.Uri.file(path.dirname(absPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    /* createDirectory is recursive and idempotent in vscode.fs */
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function appendFileSafe(absPath: string, contents: string): Promise<void> {
  const uri = vscode.Uri.file(absPath);
  let prior = '';
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    prior = Buffer.from(buf).toString('utf8');
  } catch {
    /* file does not exist yet */
  }
  const next = prior ? `${prior.replace(/\s+$/, '')}\n\n${contents}` : contents;
  await writeFileSafe(absPath, next);
}

function languageForExtension(extWithDot: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.c': 'c', '.h': 'c',
    '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.scala': 'scala',
    '.lua': 'lua',
    '.dart': 'dart'
  };
  return map[extWithDot.toLowerCase()] ?? 'plaintext';
}

function sanitiseFilename(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

function defaultTestFilename(relPath: string, language: string): string {
  const base = path.basename(relPath, path.extname(relPath));
  const lang = (language || '').toLowerCase();
  if (lang.startsWith('py')) return `test_${base}.py`;
  if (lang === 'go') return `${base}_test.go`;
  if (lang === 'rust') return `${base}_test.rs`;
  if (lang === 'java' || lang === 'kotlin') return `${base}Test.${lang === 'kotlin' ? 'kt' : 'java'}`;
  if (lang === 'csharp') return `${base}Tests.cs`;
  // Default: TS/JS-style .test.ts
  return `${base}.test.ts`;
}

function displayEndpoint(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    return u.host;
  } catch {
    return baseURL;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Compute the relative import specifier the model should use inside any
 * generated TS/JS test for `srcRelPath`. The test will live at
 * `<outputDir>/tests/<srcRelPath>.d/<filename>`, so we walk back to the
 * workspace root and forward into the source file (without extension).
 *
 * Always returns POSIX-style separators because module specifiers in
 * TS/JS code use `/` regardless of host OS.
 */
function computeImportSpecifier(srcRelPath: string, outputDir: string): string {
  const posixSrc = srcRelPath.replace(/\\/g, '/');
  const testDir = `${outputDir.replace(/\\/g, '/')}/tests/${posixSrc}.d`;
  const rel = path.posix.relative(testDir, posixSrc);
  // Strip a known JS/TS-style extension so the import works under both
  // bundlers and Node-with-extension-resolution.
  return rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
}

/**
 * Drop a single conftest.py at `<outputDir>/tests/conftest.py` so pytest
 * has the workspace root on `sys.path`. Idempotent — safe to call from
 * every cycle that produces Python tests.
 */
async function ensurePyConftest(outputDirAbs: string): Promise<void> {
  const target = path.join(outputDirAbs, 'tests', 'conftest.py');
  const existing = await readFileOrEmpty(target);
  if (existing.includes('# QuickCode-conftest-v1')) return;
  const body =
    '# QuickCode-conftest-v1\n' +
    '# Auto-generated. Adds the workspace root to sys.path so background-generated\n' +
    '# tests can import workspace-rooted modules (e.g. `from src.foo import ...`).\n' +
    'import os, sys\n' +
    "sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))\n";
  await writeFileSafe(target, body);
}

async function readFileOrEmpty(absPath: string): Promise<string> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    return Buffer.from(buf).toString('utf8');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Topic-driven helpers                                                */
/* ------------------------------------------------------------------ */

interface PlannerOutput {
  brief: string;
  topics: Array<{ id: string; title: string; rationale: string; hints: string[] }>;
}

interface TopicAnalysisResult {
  skip: boolean;
  summary: string;
  doc: string;
  files_examined: string[];
  bugs: TopicBug[];
  uncertainties: AnalysisUncertainty[];
}

interface TopicBug {
  file: string;
  line: number | null;
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
}

/** Slugify an arbitrary string into a stable topic id. */
function slugifyTopicId(s: string, fallback: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

/** Defensive-deserialise an array of topics loaded from disk. */
function sanitizeTopics(arr: unknown[]): TopicState[] {
  const out: TopicState[] = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const idRaw = typeof r.id === 'string' ? r.id : '';
    const title = typeof r.title === 'string' ? r.title : '';
    if (!title) continue;
    const id = idRaw ? slugifyTopicId(idRaw, `topic-${i}`) : slugifyTopicId(title, `topic-${i}`);
    const status =
      r.status === 'done' || r.status === 'skipped' || r.status === 'error' || r.status === 'pending'
        ? r.status
        : 'pending';
    out.push({
      id,
      title,
      rationale: typeof r.rationale === 'string' ? r.rationale : '',
      hints: Array.isArray(r.hints) ? r.hints.filter((h): h is string => typeof h === 'string') : [],
      status: status as TopicState['status'],
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
      filesExamined: Array.isArray(r.filesExamined)
        ? r.filesExamined.filter((p): p is string => typeof p === 'string')
        : undefined,
      bugs: typeof r.bugs === 'number' ? r.bugs : undefined,
      uncertainties: typeof r.uncertainties === 'number' ? r.uncertainties : undefined,
      lastError: typeof r.lastError === 'string' ? r.lastError : undefined,
      attempts: typeof r.attempts === 'number' ? r.attempts : undefined
    });
  }
  return out;
}

/** Pick the first pending topic in plan order; returns undefined if all done. */
function pickNextPendingTopic(state: ExplorerState): TopicState | undefined {
  return (state.topics ?? []).find((t) => t.status === 'pending');
}

/**
 * Pick up to `n` pending topics in plan order. Used to dispatch a parallel
 * batch in a single cycle. Returns an empty array when nothing is pending.
 */
function pickPendingTopics(state: ExplorerState, n: number): TopicState[] {
  const out: TopicState[] = [];
  for (const t of state.topics ?? []) {
    if (t.status !== 'pending') continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Pull a parseable JSON object out of arbitrary model output.
 *
 * Strategy:
 *   1. Try the naive `outer-most {...}` slice first (cheapest, works when the
 *      model obeys the prompt and emits JSON only).
 *   2. If that fails, brace-walk every `{` in the string and try the
 *      balanced span ending at the matching `}`. The longest valid span
 *      wins. This catches cases where the model wraps the JSON in prose
 *      or fenced code blocks, or emits stray `{...}` snippets before the
 *      real report.
 *
 * We deliberately do NOT attempt to fix invalid JSON (trailing commas,
 * missing quotes, etc.) — that's the model's job; we just locate it.
 */
function extractJsonObject(raw: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  if (!cleaned) return undefined;

  // Fast path: the entire text is the JSON object (model obeyed prompt).
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const fastCandidate = cleaned.slice(start, end + 1);
    try {
      JSON.parse(fastCandidate);
      return fastCandidate;
    } catch {
      /* fall through to brace-walking */
    }
  }

  // Brace-walking: enumerate balanced JSON-object spans and pick the
  // longest one that actually parses. We track string state so braces
  // inside string literals don't fool the matcher.
  let best: string | undefined;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(i, j + 1);
          try {
            JSON.parse(candidate);
            if (!best || candidate.length > best.length) best = candidate;
          } catch {
            /* not valid JSON — skip */
          }
          break;
        }
      }
    }
  }
  return best;
}

function parseBriefAndTopics(raw: string): PlannerOutput | undefined {
  const candidate = extractJsonObject(raw);
  if (!candidate) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const brief = typeof o.brief === 'string' ? o.brief.slice(0, 16_000) : '';
  if (!brief) return undefined;
  const seen = new Set<string>();
  const topics: PlannerOutput['topics'] = Array.isArray(o.topics)
    ? o.topics
        .map((t, i): PlannerOutput['topics'][number] | undefined => {
          if (!t || typeof t !== 'object') return undefined;
          const r = t as Record<string, unknown>;
          const title = typeof r.title === 'string' ? r.title.trim().slice(0, 240) : '';
          if (!title) return undefined;
          const idRaw = typeof r.id === 'string' ? r.id : title;
          let id = slugifyTopicId(idRaw, `topic-${i + 1}`);
          // Ensure uniqueness within the planner output.
          let n = 2;
          while (seen.has(id)) {
            id = `${slugifyTopicId(idRaw, `topic-${i + 1}`)}-${n++}`;
          }
          seen.add(id);
          return {
            id,
            title,
            rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 2000) : '',
            hints: Array.isArray(r.hints)
              ? r.hints.filter((h): h is string => typeof h === 'string').slice(0, 16)
              : []
          };
        })
        .filter((t): t is PlannerOutput['topics'][number] => !!t)
    : [];
  if (topics.length === 0) return undefined;
  return { brief, topics };
}

function parseTopicResult(raw: string): TopicAnalysisResult | undefined {
  const candidate = extractJsonObject(raw);
  if (!candidate) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const bugs: TopicBug[] = Array.isArray(o.bugs)
    ? o.bugs
        .map((b): TopicBug | undefined => {
          if (!b || typeof b !== 'object') return undefined;
          const r = b as Record<string, unknown>;
          const sev = String(r.severity ?? 'low').toLowerCase();
          const file = typeof r.file === 'string' ? r.file : '';
          return {
            file,
            line: typeof r.line === 'number' ? r.line : null,
            severity: (sev === 'high' || sev === 'medium' ? sev : 'low') as TopicBug['severity'],
            title: String(r.title ?? '').slice(0, 200),
            description: String(r.description ?? '').slice(0, 4000)
          };
        })
        .filter((b): b is TopicBug => !!b && (!!b.title || !!b.description))
    : [];
  const uncertainties: AnalysisUncertainty[] = Array.isArray(o.uncertainties)
    ? o.uncertainties
        .map((u): AnalysisUncertainty | undefined => {
          if (!u || typeof u !== 'object') return undefined;
          const r = u as Record<string, unknown>;
          return {
            topic: String(r.topic ?? '').slice(0, 300),
            rationale: String(r.rationale ?? '').slice(0, 2000),
            language: String(r.language ?? '').toLowerCase(),
            framework: String(r.framework ?? ''),
            filename: String(r.filename ?? ''),
            test_code: String(r.test_code ?? '')
          };
        })
        .filter((u): u is AnalysisUncertainty => !!u && !!u.test_code)
    : [];
  const filesExamined = Array.isArray(o.files_examined)
    ? (o.files_examined as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  return {
    skip: o.skip === true,
    summary: String(o.summary ?? '').slice(0, 2000),
    doc: String(o.doc ?? '').slice(0, 32_000),
    files_examined: filesExamined,
    bugs,
    uncertainties
  };
}

function renderProjectBriefMarkdown(brief: string, topics: TopicState[]): string {
  const lines: string[] = [];
  lines.push('# Project brief');
  lines.push('');
  lines.push(`_Generated by QuickCode background explorer at ${new Date().toISOString()}_`);
  lines.push('');
  lines.push(brief.trim());
  lines.push('');
  lines.push('## Investigation backlog');
  lines.push('');
  for (const t of topics) {
    const status = t.status.toUpperCase();
    lines.push(`- **[${status}] ${t.title}** _(id: \`${t.id}\`)_`);
    if (t.rationale) lines.push(`  - ${t.rationale}`);
    if (t.hints.length > 0) lines.push(`  - hints: ${t.hints.map((h) => `\`${h}\``).join(', ')}`);
    if (t.filesExamined && t.filesExamined.length > 0) {
      lines.push(`  - examined: ${t.filesExamined.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${t.filesExamined.length > 8 ? ', …' : ''}`);
    }
    if (t.bugs || t.uncertainties) {
      lines.push(`  - findings: ${t.bugs ?? 0} bug(s), ${t.uncertainties ?? 0} test(s)`);
    }
    if (t.lastError) lines.push(`  - last error: ${t.lastError}`);
  }
  return lines.join('\n');
}

function renderTopicReportMarkdown(topic: TopicState, r: TopicAnalysisResult): string {
  const lines: string[] = [];
  lines.push(`# ${topic.title}`);
  lines.push('');
  lines.push(`_Topic id: \`${topic.id}\` — generated at ${new Date().toISOString()}_`);
  lines.push('');
  if (topic.rationale) {
    lines.push('> ' + topic.rationale);
    lines.push('');
  }
  if (r.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(r.summary.trim());
    lines.push('');
  }
  if (r.doc) {
    lines.push('## Findings');
    lines.push('');
    lines.push(r.doc.trim());
    lines.push('');
  }
  if (r.files_examined.length > 0) {
    lines.push('## Files examined');
    lines.push('');
    for (const f of r.files_examined) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (r.bugs.length > 0) {
    lines.push('## Potential issues');
    lines.push('');
    for (const b of r.bugs) {
      const where = b.line ? `${b.file}:${b.line}` : b.file || 'unspecified';
      lines.push(`- **[${b.severity.toUpperCase()}] ${b.title}** (\`${where}\`) — ${b.description}`);
    }
    lines.push('');
  }
  if (r.uncertainties.length > 0) {
    lines.push('## Uncertainties / generated tests');
    lines.push('');
    for (const u of r.uncertainties) {
      lines.push(`- **${u.topic}** — ${u.rationale} _(${u.language}/${u.framework})_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderTopicBugsMarkdown(topic: TopicState, r: TopicAnalysisResult): string {
  const lines: string[] = [];
  lines.push(`## Topic ${topic.id} — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`_${topic.title}_`);
  lines.push('');
  for (const b of r.bugs) {
    const where = b.line ? `${b.file}:${b.line}` : b.file || 'unspecified';
    lines.push(`- **[${b.severity.toUpperCase()}] ${b.title}** (\`${where}\`)`);
    if (b.description) lines.push(`  - ${b.description.split('\n').join('\n    ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderTestFileForTopic(topic: TopicState, u: AnalysisUncertainty): string {
  const banner =
    `// QuickCode background-generated test for topic: ${topic.title}\n` +
    `// Topic id: ${topic.id}\n` +
    `// Sub-topic: ${u.topic}\n` +
    `// Rationale: ${u.rationale}\n` +
    `// Framework: ${u.framework}\n` +
    `// NOTE: this test was machine-generated for verification of an\n` +
    `// uncertainty; review and adjust imports/paths before running.\n\n`;
  const isPython = u.language.startsWith('py');
  const commentBanner = isPython ? banner.replace(/^\/\//gm, '#') : banner;
  return commentBanner + u.test_code.trim() + '\n';
}

function defaultTopicTestFilename(topicId: string, language: string): string {
  const lang = (language || '').toLowerCase();
  if (lang.startsWith('py')) return `test_${topicId}.py`;
  if (lang === 'go') return `${topicId}_test.go`;
  if (lang === 'rust') return `${topicId}_test.rs`;
  if (lang === 'java') return `${topicId}Test.java`;
  if (lang === 'kotlin') return `${topicId}Test.kt`;
  if (lang === 'csharp') return `${topicId}Tests.cs`;
  return `${topicId}.test.ts`;
}
