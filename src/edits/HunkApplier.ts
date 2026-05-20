import * as vscode from 'vscode';
import * as path from 'path';
import { DiffPreview } from './DiffPreview';
import { Logger } from '../util/Logger';
import { GitCheckpoint } from '../git/GitCheckpoint';

export interface ProposedHunk {
  startLine: number; // 1-indexed inclusive
  endLine: number;   // 1-indexed inclusive
  newText: string;
}

export interface ProposedEditFile {
  path: string;
  hunks: ProposedHunk[];
}

interface PendingHunk {
  id: string;
  fileUri: vscode.Uri;
  hunk: ProposedHunk;
  status: 'pending' | 'accepted' | 'rejected';
}

interface PendingFile {
  uri: vscode.Uri;
  proposedUri: vscode.Uri;
  originalContent: string;
  modifiedContent: string;
  hunks: PendingHunk[];
  eol: string;
  /**
   * True when the target file does not exist on disk yet. The flush path
   * writes `modifiedContent` to a freshly-created file instead of running
   * a hunk-by-hunk WorkspaceEdit (which would need an existing document).
   */
  isNewFile: boolean;
  /** Latest summary string that touched this file, for the chat banner. */
  lastSummary: string;
}

interface DecisionListener {
  (event: { fileUri: vscode.Uri; allDone: boolean }): void;
}

interface DecisionRecord {
  fileName: string;
  accepted: number;
  rejected: number;
  totalHunks: number;
}

/**
 * A flat, JSON-serializable view of one pending file. The webview uses these
 * entries to render a clickable file list inside the pending-edits banner so
 * users can jump directly into the diff editor for a specific file.
 */
export interface PendingFileSummary {
  /** Stable identifier (the source `vscode.Uri.toString()`), used for IPC. */
  uri: string;
  /** Workspace-relative POSIX path when possible, else the absolute fsPath. */
  path: string;
  /** Just the basename, for compact display. */
  name: string;
  /** Hunks still awaiting a decision. */
  pendingHunks: number;
  /** Hunks already accepted but not yet flushed (file still in the queue). */
  acceptedHunks: number;
  /** Hunks already rejected. */
  rejectedHunks: number;
  /** True for files that don't exist on disk yet (creation flow). */
  isNewFile: boolean;
}

export interface PendingState {
  /** Number of files with at least one pending hunk. */
  files: number;
  /** Total number of pending hunks across all files. */
  hunks: number;
  /** Per-file summaries for rendering a clickable list in the banner. */
  fileList: PendingFileSummary[];
  /** Latest propose_edit summary, for display in the chat banner. */
  latestSummary?: string;
  /**
   * If the most recent state change was a user decision (accept/reject),
   * a short summary suitable for an inline chat note. One-shot: emitted once
   * then cleared on the next pendingStateChange.
   */
  recentDecision?: string;
}

export class HunkApplier implements vscode.Disposable {
  private readonly pending = new Map<string, PendingFile>(); // key = source uri toString
  private readonly listeners: DecisionListener[] = [];
  private codeLensProvider: HunkCodeLensProvider;
  private codeLensRegistration: vscode.Disposable;
  /**
   * Per-cycle journal: cleared whenever a `consumeDecisionSummary` is called.
   * Appended to whenever a file's hunks have all been decided. The chat side
   * uses this to show a one-shot inline note like "✓ accepted 3 hunks".
   */
  private decisionJournal: DecisionRecord[] = [];
  /** Latest user-facing summary passed to `proposeEdits`. */
  private latestSummary?: string;
  /**
   * Per-file mutex chain. Concurrent `proposeEdits` calls (e.g. multiple
   * propose_edit tool calls dispatched in parallel by the agent loop, or
   * sub-agents running fan-out writes) targeting the SAME file are serialized
   * through this map so `loadOriginal` / `modifiedContent` recomputation
   * never interleave. Calls touching DIFFERENT files keep running in
   * parallel — that is the whole point of unlocking propose_edit.
   */
  private readonly fileLocks = new Map<string, Promise<void>>();
  /**
   * One-shot guard for the per-cycle "preamble" work (git checkpoint + first
   * diff editor open). Concurrent callers entering an empty pending set all
   * `await` the same promise so we don't create duplicate checkpoints or
   * spam multiple diff tabs. Cleared whenever the pending set drains so the
   * next propose_edit cycle starts a fresh checkpoint.
   */
  private cycleInitPromise: Promise<void> | null = null;
  /**
   * True once the diff editor for the first newly-queued file in the current
   * cycle has been opened. Reset together with `cycleInitPromise`.
   */
  private diffOpenedThisCycle = false;
  private readonly stateEmitter = new vscode.EventEmitter<PendingState>();
  /** Fires whenever pending edits are added, accepted, or rejected. */
  readonly onPendingStateChange = this.stateEmitter.event;

  constructor(
    private readonly diffPreview: DiffPreview,
    private readonly logger: Logger,
    private readonly gitCheckpoint?: GitCheckpoint
  ) {
    this.codeLensProvider = new HunkCodeLensProvider(this);
    this.codeLensRegistration = vscode.languages.registerCodeLensProvider(
      [{ scheme: DiffPreview.scheme }, { scheme: 'file' }],
      this.codeLensProvider
    );
  }

  /** Snapshot of the current pending state, suitable for re-broadcasting. */
  getPendingState(): PendingState {
    let hunks = 0;
    let files = 0;
    const fileList: PendingFileSummary[] = [];
    for (const f of this.pending.values()) {
      const pendingCount = f.hunks.filter((h) => h.status === 'pending').length;
      const acceptedCount = f.hunks.filter((h) => h.status === 'accepted').length;
      const rejectedCount = f.hunks.filter((h) => h.status === 'rejected').length;
      if (pendingCount > 0) {
        files++;
        hunks += pendingCount;
      }
      fileList.push({
        uri: f.uri.toString(),
        path: this.workspaceRelative(f.uri),
        name: path.basename(f.uri.fsPath),
        pendingHunks: pendingCount,
        acceptedHunks: acceptedCount,
        rejectedHunks: rejectedCount,
        isNewFile: f.isNewFile
      });
    }
    // Stable order: files with pending hunks first, then by path.
    fileList.sort((a, b) => {
      if ((b.pendingHunks > 0 ? 1 : 0) !== (a.pendingHunks > 0 ? 1 : 0)) {
        return (b.pendingHunks > 0 ? 1 : 0) - (a.pendingHunks > 0 ? 1 : 0);
      }
      return a.path.localeCompare(b.path);
    });
    return { files, hunks, fileList, latestSummary: this.latestSummary };
  }

  /**
   * Compute a workspace-relative POSIX path for display. Falls back to the
   * absolute fsPath when the file lives outside the open workspace folders.
   */
  private workspaceRelative(uri: vscode.Uri): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
    }
    return uri.fsPath;
  }

  private emitState(extra?: Partial<PendingState>): void {
    const base = this.getPendingState();
    this.stateEmitter.fire({ ...base, ...extra });
  }

  onDecision(listener: DecisionListener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
  }

  pendingFiles(): PendingFile[] {
    return Array.from(this.pending.values());
  }

  /**
   * Queue line-based edits for user review. Non-blocking: returns immediately.
   *
   * Multiple calls accumulate hunks per file. If a new hunk's range overlaps
   * an existing PENDING hunk (last-write-wins), the existing one is dropped.
   * Already-decided hunks are preserved. The diff editor for each touched
   * file is refreshed in place rather than re-opened, so calling this many
   * times across the same chat run does not spawn a flood of new editors.
   *
   * The user accepts/rejects at their leisure via the chat banner or the
   * inline CodeLenses — even across multiple agent turns.
   */
  async proposeEdits(files: ProposedEditFile[], summary: string): Promise<void> {
    if (files.length === 0) return;
    this.latestSummary = summary;
    // One-shot per-cycle preamble (checkpoint). Concurrent callers all await
    // the same promise so we never create duplicate checkpoints or open
    // multiple diff tabs even when the agent dispatches several propose_edit
    // calls in parallel.
    await this.ensureCycleInit(summary);

    // Process every file under its own lock. Different files run concurrently
    // (the parallelism win); same-file calls serialize so loadOriginal +
    // modifiedContent recomputation stay consistent.
    let firstNewlyQueuedUri: vscode.Uri | undefined;
    await Promise.all(
      files.map((f) =>
        this.withFileLock(this.resolveUri(f.path).toString(), async () => {
          const queuedNew = await this.processFile(f, summary);
          if (queuedNew && !firstNewlyQueuedUri) firstNewlyQueuedUri = queuedNew;
        })
      )
    );

    this.codeLensProvider.refresh();
    // Open a diff editor for the first newly-queued file in this CYCLE (not
    // just this call). Subsequent files quietly accumulate in the banner —
    // users can click into them from there. `diffOpenedThisCycle` makes this
    // safe under concurrency.
    if (firstNewlyQueuedUri && !this.diffOpenedThisCycle) {
      this.diffOpenedThisCycle = true;
      const entry = this.pending.get(firstNewlyQueuedUri.toString());
      if (entry) {
        try {
          if (entry.isNewFile) {
            // Nothing exists on disk yet — a 2-pane diff would render "File
            // not found" on the right. Show the proposed virtual document
            // directly; CodeLenses still work because the diff-preview
            // scheme is registered with the CodeLens provider.
            await vscode.window.showTextDocument(entry.proposedUri, { preview: true });
          } else {
            await vscode.commands.executeCommand(
              'vscode.diff',
              entry.proposedUri,
              entry.uri,
              `BurstCode • ${path.basename(entry.uri.fsPath)} (Proposed ↔ Current)`
            );
          }
        } catch (err) {
          this.logger.warn('Failed to open initial diff editor', String(err));
        }
      }
    }
    this.logger.info('Proposed edits queued', { files: files.length, summary });
    this.emitState();
  }

  /**
   * Run `fn` exclusively per `key`. Subsequent calls with the same key chain
   * onto the previous one; failures don't poison the chain (we swallow them
   * in the chained `then` so the next waiter still gets a turn). The map
   * entry is cleaned up once the chain we just appended drains.
   */
  private async withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a forgiving handle so concurrent waiters never see a rejected
    // promise; the real result is still surfaced to the caller below.
    const handle = next.then(
      () => undefined,
      () => undefined
    );
    this.fileLocks.set(key, handle);
    try {
      return await next;
    } finally {
      // If nobody chained after us, drop the entry to avoid an unbounded map.
      if (this.fileLocks.get(key) === handle) {
        this.fileLocks.delete(key);
      }
    }
  }

  /**
   * Lazily run the per-cycle preamble exactly once across all concurrent
   * `proposeEdits` callers. The promise is cleared in `flushFileIfDone` once
   * the pending set drains, which is what defines a "cycle" for us.
   */
  private ensureCycleInit(summary: string): Promise<void> {
    if (this.cycleInitPromise) return this.cycleInitPromise;
    this.cycleInitPromise = (async () => {
      if (this.gitCheckpoint && this.pending.size === 0) {
        try {
          await this.gitCheckpoint.createCheckpoint(`pre-edit • ${summary}`);
        } catch (err) {
          this.logger.warn('Pre-edit checkpoint failed', String(err));
        }
      }
    })();
    return this.cycleInitPromise;
  }

  /**
   * Queue a single file's hunks. Returns the file's source URI when the file
   * was NEWLY queued (i.e. did not already have a PendingFile entry) so the
   * caller can decide whether to open a diff editor for it. Must be called
   * under that file's lock.
   */
  private async processFile(
    f: ProposedEditFile,
    summary: string
  ): Promise<vscode.Uri | undefined> {
    const uri = this.resolveUri(f.path);
    const key = uri.toString();
    let entry = this.pending.get(key);
    let newlyQueued: vscode.Uri | undefined;
    if (!entry) {
      const loaded = await this.loadOriginal(uri);
      const proposedUri = this.diffPreview.registerProposed(uri, loaded.content);
      entry = {
        uri,
        proposedUri,
        originalContent: loaded.content,
        modifiedContent: loaded.content,
        hunks: [],
        eol: loaded.eol,
        isNewFile: loaded.isNewFile,
        lastSummary: summary
      };
      this.pending.set(key, entry);
      newlyQueued = uri;
    } else {
      entry.lastSummary = summary;
    }

    const stamp = Date.now();
    const newPending: PendingHunk[] = f.hunks.map((h, i) => ({
      id: `${key}::${stamp}::${i}`,
      fileUri: uri,
      hunk: h,
      status: 'pending'
    }));
    // Drop existing PENDING hunks whose ranges overlap any newly-queued one.
    // Already-accepted hunks are kept (they will be applied alongside the
    // new ones when the file is finally flushed).
    entry.hunks = entry.hunks.filter((existing) => {
      if (existing.status !== 'pending') return true;
      return !newPending.some((nh) => hunksOverlap(existing.hunk, nh.hunk));
    });
    entry.hunks.push(...newPending);

    // Recompute modified content from the cached original + every
    // pending/accepted hunk, applied bottom-up so ranges stay valid.
    const stack = entry.hunks
      .filter((h) => h.status === 'pending' || h.status === 'accepted')
      .map((h) => h.hunk)
      .sort((a, b) => b.startLine - a.startLine);
    let modified = entry.originalContent;
    for (const h of stack) modified = applyHunkToText(modified, h, entry.eol);
    entry.modifiedContent = modified;
    // Re-register with the new content; this fires onDidChange on the diff
    // provider and existing diff editors refresh in place.
    this.diffPreview.registerProposed(uri, modified);
    return newlyQueued;
  }

  /** Open the diff editor for the first file with pending hunks (Review button). */
  async openPendingDiff(): Promise<void> {
    // Prefer files that still have pending hunks; fall back to any queued file.
    const entries = Array.from(this.pending.values());
    const target =
      entries.find((f) => f.hunks.some((h) => h.status === 'pending')) ?? entries[0];
    if (!target) return;
    await this.openDiffForEntry(target);
  }

  /**
   * Open the diff editor for a specific queued file. The webview's banner
   * file list calls this so users can step through each changed file
   * individually instead of always landing on the first one.
   *
   * Accepts the source uri.toString() (as returned in `PendingFileSummary.uri`).
   */
  async openDiffForFile(sourceUriKey: string): Promise<void> {
    const entry = this.pending.get(sourceUriKey);
    if (!entry) return;
    await this.openDiffForEntry(entry);
  }

  private async openDiffForEntry(entry: PendingFile): Promise<void> {
    if (entry.isNewFile) {
      // Brand-new file: nothing on disk to compare against, so open the
      // proposed virtual document directly. CodeLenses still work because
      // the diff-preview scheme is registered with the CodeLens provider.
      await vscode.window.showTextDocument(entry.proposedUri, { preview: true });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.proposedUri,
      entry.uri,
      `BurstCode • ${path.basename(entry.uri.fsPath)} (Proposed ↔ Current)`
    );
  }

  async acceptHunk(hunkId: string): Promise<void> {
    const target = this.findHunkById(hunkId);
    if (!target) return;
    target.hunk.status = 'accepted';
    await this.flushFileIfDone(target.file);
    this.emitState({ recentDecision: this.consumeDecisionSummary() });
  }

  async rejectHunk(hunkId: string): Promise<void> {
    const target = this.findHunkById(hunkId);
    if (!target) return;
    target.hunk.status = 'rejected';
    await this.flushFileIfDone(target.file);
    this.emitState({ recentDecision: this.consumeDecisionSummary() });
  }

  async acceptAll(): Promise<void> {
    for (const file of Array.from(this.pending.values())) {
      for (const h of file.hunks) if (h.status === 'pending') h.status = 'accepted';
      await this.flushFileIfDone(file);
    }
    this.emitState({ recentDecision: this.consumeDecisionSummary() });
  }

  async rejectAll(): Promise<void> {
    for (const file of Array.from(this.pending.values())) {
      for (const h of file.hunks) if (h.status === 'pending') h.status = 'rejected';
      await this.flushFileIfDone(file);
    }
    this.emitState({ recentDecision: this.consumeDecisionSummary() });
  }

  /**
   * Snapshot and clear the decision journal accumulated since the last
   * `proposeEdits` call. Returns a short human-readable string the agent loop
   * feeds back to the model so it knows whether to retry, follow up, or stop.
   */
  consumeDecisionSummary(): string {
    const journal = this.decisionJournal;
    this.decisionJournal = [];
    if (journal.length === 0) return 'no decisions recorded';
    let totalAcc = 0;
    let totalRej = 0;
    const parts = journal.map((d) => {
      totalAcc += d.accepted;
      totalRej += d.rejected;
      return `${d.fileName}: ${d.accepted}/${d.totalHunks} accepted, ${d.rejected} rejected`;
    });
    const verdict =
      totalAcc > 0 && totalRej === 0
        ? 'all hunks accepted'
        : totalAcc === 0 && totalRej > 0
          ? 'all hunks rejected'
          : `${totalAcc} accepted, ${totalRej} rejected`;
    return `${verdict} — ${parts.join('; ')}`;
  }

  /** Wait until all currently pending files are decided. */
  async waitForAllDecisions(token?: vscode.CancellationToken): Promise<void> {
    if (this.pending.size === 0) return;
    return new Promise((resolve) => {
      const sub = this.onDecision((evt) => {
        if (this.pending.size === 0) {
          sub.dispose();
          resolve();
        }
      });
      token?.onCancellationRequested(() => {
        sub.dispose();
        resolve();
      });
    });
  }

  private async flushFileIfDone(file: PendingFile): Promise<void> {
    const stillPending = file.hunks.some((h) => h.status === 'pending');
    if (stillPending) return;
    const acceptedHunks = file.hunks.filter((h) => h.status === 'accepted');
    const rejectedHunks = file.hunks.filter((h) => h.status === 'rejected');
    this.decisionJournal.push({
      fileName: path.basename(file.uri.fsPath),
      accepted: acceptedHunks.length,
      rejected: rejectedHunks.length,
      totalHunks: file.hunks.length
    });
    const accepted = acceptedHunks.map((h) => h.hunk);
    if (accepted.length > 0) {
      if (file.isNewFile) {
        // Brand-new file: compose the final content from the empty original +
        // every accepted hunk, then create + write in one shot. Going through
        // WorkspaceEdit.replace would fail because there is no document yet.
        let composed = file.originalContent;
        const sorted = [...accepted].sort((a, b) => b.startLine - a.startLine);
        for (const h of sorted) composed = applyHunkToText(composed, h, file.eol);
        try {
          await ensureParentDir(file.uri);
          await vscode.workspace.fs.writeFile(file.uri, Buffer.from(composed, 'utf8'));
          this.logger.info('Created file', { uri: file.uri.toString(), hunks: accepted.length });
        } catch (err) {
          vscode.window.showErrorMessage(
            `BurstCode: failed to create ${path.basename(file.uri.fsPath)}: ${String(err)}`
          );
        }
      } else {
        const doc = await vscode.workspace.openTextDocument(file.uri);
        const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const wsEdit = new vscode.WorkspaceEdit();
        // Apply in descending startLine order to keep ranges valid.
        const sorted = [...accepted].sort((a, b) => b.startLine - a.startLine);
        for (const h of sorted) {
          const range = hunkToRange(doc, h);
          const replacement = ensureTrailingEol(h.newText, eol, h.startLine === h.endLine + 1);
          wsEdit.replace(file.uri, range, replacement);
        }
        const ok = await vscode.workspace.applyEdit(wsEdit);
        if (ok) {
          await doc.save();
          this.logger.info('Applied edits', { uri: file.uri.toString(), hunks: accepted.length });
        } else {
          vscode.window.showErrorMessage(
            `BurstCode: failed to apply edits to ${path.basename(file.uri.fsPath)}.`
          );
        }
      }
    }
    this.diffPreview.unregister(file.proposedUri);
    this.pending.delete(file.uri.toString());
    this.codeLensProvider.refresh();
    // Cycle ended — clear the per-cycle guards so the NEXT propose_edit run
    // creates a fresh checkpoint and is allowed to open one diff editor.
    if (this.pending.size === 0) {
      this.cycleInitPromise = null;
      this.diffOpenedThisCycle = false;
    }
    for (const l of this.listeners) {
      try {
        l({ fileUri: file.uri, allDone: this.pending.size === 0 });
      } catch (e) {
        this.logger.error('decision listener failed', String(e));
      }
    }
  }

  private findHunkById(id: string): { file: PendingFile; hunk: PendingHunk } | undefined {
    for (const f of this.pending.values()) {
      const h = f.hunks.find((x) => x.id === id);
      if (h) return { file: f, hunk: h };
    }
    return undefined;
  }

  private resolveUri(p: string): vscode.Uri {
    if (p.startsWith('file:')) return vscode.Uri.parse(p);
    if (path.isAbsolute(p)) return vscode.Uri.file(p);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('No workspace folder open.');
    return vscode.Uri.file(path.join(root, p));
  }

  /**
   * Read a target file's current contents, falling back to an empty buffer if
   * the file does not exist yet. We probe with `fs.stat` first so that a
   * "file missing" path is distinguished cleanly from a real I/O error
   * (permission denied, encoding issue, ...). This is what enables
   * propose_edit to create brand-new files.
   */
  private async loadOriginal(
    uri: vscode.Uri
  ): Promise<{ content: string; eol: string; isNewFile: boolean }> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (err) {
      const isMissing =
        err instanceof vscode.FileSystemError
          ? err.code === 'FileNotFound' || err.code === 'EntryNotFound'
          : true;
      if (isMissing) {
        return { content: '', eol: '\n', isNewFile: true };
      }
      throw err;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    return {
      content: doc.getText(),
      eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      isNewFile: false
    };
  }

  /** Get pending hunks for a file URI (used by CodeLens provider). */
  getPendingForUri(uri: vscode.Uri): PendingHunk[] {
    // The diff editor opens both `proposedUri` (burstcode-preview) and the source `uri`.
    if (uri.scheme === DiffPreview.scheme) {
      const sourceUri = uri.with({ scheme: 'file', path: uri.path.replace(/\.proposed$/, '') });
      return this.pending.get(sourceUri.toString())?.hunks ?? [];
    }
    return this.pending.get(uri.toString())?.hunks ?? [];
  }

  dispose(): void {
    this.codeLensRegistration.dispose();
    this.stateEmitter.dispose();
  }
}

/**
 * Make sure the parent directory of `uri` exists so a subsequent
 * `vscode.workspace.fs.writeFile` succeeds when creating a brand-new file
 * (e.g. when propose_edit targets `core/prompt_utils.py` but `core/` does
 * not exist yet). `createDirectory` is idempotent in the VS Code FS API.
 */
async function ensureParentDir(uri: vscode.Uri): Promise<void> {
  const parent = uri.with({ path: path.posix.dirname(uri.path) });
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    /* already exists or filesystem refused — writeFile will surface a real error */
  }
}

function hunksOverlap(a: ProposedHunk, b: ProposedHunk): boolean {
  // Inclusive ranges [startLine, endLine] are considered overlapping if they
  // intersect at all. Pure insertions (startLine == endLine + 1) collapse to
  // an empty range and never overlap anything.
  const aEmpty = a.startLine > a.endLine;
  const bEmpty = b.startLine > b.endLine;
  if (aEmpty || bEmpty) return false;
  return !(a.endLine < b.startLine || b.endLine < a.startLine);
}

class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly applier: HunkApplier) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const hunks = this.applier.getPendingForUri(document.uri);
    if (hunks.length === 0) return [];
    return hunks
      .filter((h) => h.status === 'pending')
      .map((h) => {
        const lineIdx = Math.max(0, Math.min(document.lineCount - 1, h.hunk.startLine - 1));
        const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
        return [
          new vscode.CodeLens(range, {
            title: '✓ Accept Hunk',
            command: 'burstcode.acceptHunk',
            arguments: [h.id]
          }),
          new vscode.CodeLens(range, {
            title: '✕ Reject Hunk',
            command: 'burstcode.rejectHunk',
            arguments: [h.id]
          })
        ];
      })
      .flat();
  }
}

function applyHunkToText(text: string, h: ProposedHunk, eol: string): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, h.startLine - 1);
  const end = Math.min(lines.length, h.endLine);
  const replacement = h.newText.split(/\r?\n/);
  // If replacement ends with empty string (trailing newline), drop it to avoid double EOL.
  if (replacement.length > 0 && replacement[replacement.length - 1] === '' && h.newText.endsWith('\n')) {
    replacement.pop();
  }
  const result = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return result.join(eol);
}

function hunkToRange(doc: vscode.TextDocument, h: ProposedHunk): vscode.Range {
  const maxLine = Math.max(0, doc.lineCount - 1);
  const start = Math.max(0, Math.min(maxLine, h.startLine - 1));
  if (h.startLine > h.endLine) {
    return new vscode.Range(start, 0, start, 0);
  }
  const endLineIdx = Math.max(0, Math.min(maxLine, h.endLine - 1));
  const endChar = doc.lineAt(endLineIdx).text.length;
  return new vscode.Range(start, 0, endLineIdx, endChar);
}

function ensureTrailingEol(text: string, eol: string, _insertOnly: boolean): string {
  // Normalize line endings to the document's EOL.
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, eol);
  return normalized;
}
