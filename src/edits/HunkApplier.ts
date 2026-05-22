import * as vscode from 'vscode';
import * as path from 'path';
import { DiffPreview } from './DiffPreview';
import { Logger } from '../util/Logger';
import { GitCheckpoint } from '../git/GitCheckpoint';

export interface ProposedHunk {
  startLine: number; // 1-indexed inclusive
  endLine: number;   // 1-indexed inclusive
  newText: string;
  /**
   * Optional string anchor. When set, HunkApplier resolves this exact
   * sequence of lines against the file's current view (modifiedContent if
   * the file has pending edits, else disk content) and uses that match as
   * the (startLine, endLine) range — the caller-supplied startLine/endLine
   * become a disambiguation HINT for non-unique matches. This makes line
   * numbers tolerant to drift and is the recommended way to issue edits.
   */
  oldText?: string;
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
    //
    // Per-file error isolation: collect per-file failures here so a single
    // file's overlap-rejection does NOT swallow other files that succeeded.
    // (processFile validates BEFORE mutating, so a failed file leaves
    // `this.pending` untouched for that file — but other files in the same
    // batch may already have been queued by the time the failure surfaces.)
    let firstNewlyQueuedUri: vscode.Uri | undefined;
    const fileErrors: string[] = [];
    await Promise.all(
      files.map((f) =>
        this.withFileLock(this.resolveUri(f.path).toString(), async () => {
          try {
            const queuedNew = await this.processFile(f, summary);
            if (queuedNew && !firstNewlyQueuedUri) firstNewlyQueuedUri = queuedNew;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            fileErrors.push(`${f.path}: ${msg}`);
          }
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
              entry.uri,
              entry.proposedUri,
              `BurstCode • ${path.basename(entry.uri.fsPath)} (Current ↔ Proposed)`
            );
          }
        } catch (err) {
          this.logger.warn('Failed to open initial diff editor', String(err));
        }
      }
    }
    this.logger.info('Proposed edits queued', {
      files: files.length,
      succeeded: files.length - fileErrors.length,
      summary
    });
    // Always emit state so the banner reflects partial successes even when
    // some files were rejected.
    this.emitState();
    if (fileErrors.length > 0) {
      // Surface aggregated errors to the tool layer. Files that succeeded
      // are already queued and visible in the banner; the error message tells
      // the model which files need re-targeting.
      throw new Error(fileErrors.join(' | '));
    }
  }

  /**
   * Run `fn` exclusively per `key`. Subsequent calls with the same key chain
   * onto the previous one; failures don't poison the chain (we swallow them
   * in the chained `then` so the next waiter still gets a turn). The map
   * entry is cleaned up once the chain we just appended drains.
   */
  private async withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(key) ?? Promise.resolve();
    // Safety timeout: if fn() never resolves (e.g. loadOriginal blocked by
    // another extension), the lock chain doesn't block all subsequent edits
    // to this file forever. 30s is well above any normal file operation.
    const LOCK_TIMEOUT_MS = 30_000;
    const timedFn = async (): Promise<T> => {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`withFileLock timed out after ${LOCK_TIMEOUT_MS}ms`)), LOCK_TIMEOUT_MS)
        )
      ]);
      return result;
    };
    const next = prev.then(timedFn, timedFn);
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
    const existingEntry = this.pending.get(key);

    // ---- oldText anchor resolution ----
    // For any new hunk that supplies `oldText`, locate that exact line
    // sequence in the file's current view (modifiedContent for pending
    // files, else disk content) and rewrite (startLine, endLine) to match.
    // Done BEFORE the overlap classification so downstream logic stays
    // unchanged. Resolution failures throw so the tool surfaces a clear
    // re-target message to the model.
    let preloaded: { content: string; eol: string; isNewFile: boolean } | undefined;
    let viewContent: string | undefined = existingEntry?.modifiedContent;
    const needsOldText = f.hunks.some((h) => h.oldText !== undefined);
    if (needsOldText && viewContent === undefined) {
      preloaded = await this.loadOriginal(uri);
      viewContent = preloaded.content;
    }
    const resolvedHunks: ProposedHunk[] = f.hunks.map((h) => {
      if (h.oldText === undefined) return h;
      if (viewContent === undefined) {
        throw new Error(`oldText anchor on ${f.path} requires a readable file view`);
      }
      return resolveOldTextHunk(h, viewContent, f.path);
    });
    f = { path: f.path, hunks: resolvedHunks };

    // Translate new hunks from baseline (modifiedContent) coords into
    // originalContent coords. Rationale: read_file returns modifiedContent
    // for files with pending edits, so when the model issues a follow-up
    // propose_edit on the same file it naturally uses post-edit line numbers.
    // Internally we keep every hunk in original-coord space so the existing
    // flush path (WorkspaceEdit.replace on the live disk document) keeps
    // working unchanged.
    // Reject overlapping new hunks within THIS propose_edit call. Without
    // this guard, two new hunks that overlap each other would be silently
    // applied bottom-up and clobber one another. Pure insertions (startLine
    // > endLine) collapse to an empty range and never overlap.
    const newOverlapErrors: string[] = [];
    for (let i = 0; i < f.hunks.length; i++) {
      const a = f.hunks[i];
      if (a.startLine > a.endLine) continue;
      for (let j = i + 1; j < f.hunks.length; j++) {
        const b = f.hunks[j];
        if (b.startLine > b.endLine) continue;
        if (!(a.endLine < b.startLine || b.endLine < a.startLine)) {
          newOverlapErrors.push(
            `two new hunks in the same propose_edit overlap: lines ${a.startLine}-${a.endLine} vs ${b.startLine}-${b.endLine}. Make them disjoint.`
          );
        }
      }
    }
    if (newOverlapErrors.length > 0) {
      throw new Error(`propose_edit overlap rejected: ${newOverlapErrors.join(' | ')}`);
    }

    let translatedHunks: ProposedHunk[];
    const droppedExistingIds = new Set<string>();
    // Refinements: new hunks that fall fully INSIDE a pending hunk's modified
    // range. Instead of adding them as separate hunks (which would either
    // overlap the parent or get rejected), we splice them into the parent
    // pending hunk's newText so the model can iteratively shape one queued
    // edit. Collected here, applied after classification.
    const refinements: Array<{ targetId: string; nh: ProposedHunk; modStart: number }> = [];
    const refinedNewHunkIndices = new Set<number>();
    if (!existingEntry || existingEntry.hunks.length === 0) {
      // First propose_edit on this file: baseline === original, no translation.
      translatedHunks = f.hunks;
    } else {
      // Annotate each existing PENDING / ACCEPTED hunk with its baseline-coord
      // range and per-hunk line delta. REJECTED hunks are excluded entirely
      // because they were never applied to modifiedContent — leaving them in
      // would inflate `cum` and skew every subsequent hunk's modStart.
      const sortedExisting = existingEntry.hunks
        .filter((h) => h.status !== 'rejected')
        .slice()
        .sort((a, b) => a.hunk.startLine - b.hunk.startLine);
      let cum = 0;
      type Annot = {
        h: PendingHunk;
        modStart: number;
        modEnd: number;
        delta: number;
        isEmpty: boolean; // pure deletion: occupies zero lines in modified
      };
      const annotated: Annot[] = sortedExisting.map((h) => {
        const removed =
          h.hunk.startLine > h.hunk.endLine ? 0 : h.hunk.endLine - h.hunk.startLine + 1;
        const added = countAddedLines(h.hunk.newText);
        const modStart = h.hunk.startLine + cum;
        // Bug fix: pure deletions (added=0) occupy ZERO lines in modified
        // coords, so represent them as an empty range [modStart, modStart-1].
        // The previous `Math.max(added, 1) - 1` formula incorrectly stamped
        // them as a 1-line range, which caused spurious overlap matches and
        // off-by-one drift in the per-hunk delta calculation below.
        const modEnd = added === 0 ? modStart - 1 : modStart + added - 1;
        const delta = added - removed;
        cum += delta;
        return { h, modStart, modEnd, delta, isEmpty: added === 0 };
      });

      // Classify each new hunk against existing annotated hunks. Four cases:
      //   1. New hunk fully CONTAINS a pending hunk        -> drop pending (last-write-wins).
      //   2. Pending hunk fully CONTAINS the new hunk      -> splice the new
      //      hunk's newText into the pending hunk's newText (refinement).
      //   3. New hunk PARTIALLY overlaps a pending hunk    -> reject (silent
      //      corruption otherwise — part of the pending newText would vanish).
      //   4. New hunk overlaps an ACCEPTED hunk            -> reject (the
      //      accepted region is locked in for review; refining its newText
      //      via line numbers is fragile, ask the model to re-read instead).
      const overlapErrors: string[] = [];
      for (let nhIdx = 0; nhIdx < f.hunks.length; nhIdx++) {
        const nh = f.hunks[nhIdx];
        for (const ann of annotated) {
          if (ann.isEmpty) continue; // pure deletions never overlap anything
          const overlaps = !(nh.endLine < ann.modStart || ann.modEnd < nh.startLine);
          if (!overlaps) continue;
          const newContainsExisting =
            nh.startLine <= ann.modStart && ann.modEnd <= nh.endLine;
          const existingContainsNew =
            ann.modStart <= nh.startLine && nh.endLine <= ann.modEnd;
          if (ann.h.status === 'accepted') {
            overlapErrors.push(
              `new hunk modLines ${nh.startLine}-${nh.endLine} overlaps already-accepted hunk at modLines ${ann.modStart}-${ann.modEnd}. Re-read the file with read_file and retarget against the post-decision view.`
            );
          } else if (newContainsExisting) {
            droppedExistingIds.add(ann.h.id);
          } else if (existingContainsNew) {
            // Refinement: splice nh into ann's newText after we finish
            // classification. Record the absolute modStart of the parent
            // pending hunk so the splice target is computed against the
            // model-stable view (before any sibling refinement applies).
            refinements.push({ targetId: ann.h.id, nh, modStart: ann.modStart });
            refinedNewHunkIndices.add(nhIdx);
          } else {
            overlapErrors.push(
              `new hunk modLines ${nh.startLine}-${nh.endLine} partially overlaps pending hunk at modLines ${ann.modStart}-${ann.modEnd}. Either fully contain the pending hunk's range or shrink so the ranges do not overlap.`
            );
          }
        }
      }
      if (overlapErrors.length > 0) {
        throw new Error(`propose_edit overlap rejected: ${overlapErrors.join(' | ')}`);
      }

      // New hunks that became refinements are not added as separate pending
      // entries — their content is folded into the parent pending hunk below.
      const remainingNewHunks = f.hunks.filter((_, idx) => !refinedNewHunkIndices.has(idx));

      // Translate each remaining new hunk to original coords. We use TWO
      // cumulative deltas — one for the start line, one for the end line:
      //   - cumBeforeStart: sum of deltas of annotated hunks whose modified
      //     range ends strictly BEFORE nh.startLine. These shift both ends.
      //   - cumBeforeEnd: cumBeforeStart PLUS deltas of annotated hunks whose
      //     modified range is fully inside [nh.startLine, nh.endLine]. These
      //     "internal" hunks (always dropped because new fully contains them)
      //     get absorbed into the new hunk's original range, so the new hunk
      //     correctly replaces every original line they were pointing at.
      // Without this end-side correction, multi-hunk-subsumption used to drop
      // or duplicate one boundary line per inside hunk (the visible symptom
      // was "propose_edit replaced almost the right region but ate one extra
      // line above/below").
      translatedHunks = remainingNewHunks.map((nh) => {
        let cumBeforeStart = 0;
        let cumBeforeEnd = 0;
        for (const a of annotated) {
          if (a.isEmpty) continue;
          if (a.modEnd < nh.startLine) {
            cumBeforeStart += a.delta;
            cumBeforeEnd += a.delta;
          } else if (a.modStart >= nh.startLine && a.modEnd <= nh.endLine) {
            cumBeforeEnd += a.delta;
          }
        }
        return {
          startLine: nh.startLine - cumBeforeStart,
          endLine: nh.endLine - cumBeforeEnd,
          newText: nh.newText
        };
      });
    }

    // Validation passed (or wasn't needed). NOW create the entry if it didn't
    // exist — this way a thrown overlap rejection above leaves `this.pending`
    // completely untouched, so the tool error message ("No hunks were queued")
    // is true and concurrent calls on other files don't see torn state.
    let entry: PendingFile;
    let newlyQueued: vscode.Uri | undefined;
    if (!existingEntry) {
      // Reuse the loadOriginal result from oldText resolution if it ran.
      const loaded = preloaded ?? (await this.loadOriginal(uri));
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
      entry = existingEntry;
      entry.lastSummary = summary;
    }

    // Apply pending-hunk refinements: each refinement target is an existing
    // pending hunk whose newText we splice the new hunk into. Group by target
    // so we can splice multiple refinements into the same parent in DESC
    // order (so earlier splice indices stay valid). All refinements were
    // computed against the model-stable view, so we splice using the parent
    // hunk's ORIGINAL newText (a snapshot taken before any refinement runs).
    if (refinements.length > 0) {
      const byTarget = new Map<string, Array<{ nh: ProposedHunk; modStart: number }>>();
      for (const r of refinements) {
        const arr = byTarget.get(r.targetId) ?? [];
        arr.push({ nh: r.nh, modStart: r.modStart });
        byTarget.set(r.targetId, arr);
      }
      for (const [targetId, group] of byTarget) {
        const parent = entry.hunks.find((h) => h.id === targetId);
        if (!parent) continue; // shouldn't happen; defensive
        const trailingNewline = parent.hunk.newText.endsWith('\n');
        const parentLines = splitLogicalLines(parent.hunk.newText);
        // Splice in DESCENDING modStart order so each splice's local index
        // is computed against the original parent line array.
        group.sort((a, b) => b.nh.startLine - a.nh.startLine);
        for (const { nh, modStart } of group) {
          const localStart = nh.startLine - modStart; // 0-indexed
          if (nh.startLine > nh.endLine) {
            // Pure insertion before localStart.
            const repl = splitLogicalLines(nh.newText);
            parentLines.splice(localStart, 0, ...repl);
          } else {
            const localCount = nh.endLine - nh.startLine + 1;
            const repl = splitLogicalLines(nh.newText);
            parentLines.splice(localStart, localCount, ...repl);
          }
        }
        parent.hunk.newText = parentLines.join('\n') + (trailingNewline ? '\n' : '');
      }
    }

    const stamp = Date.now();
    const newPending: PendingHunk[] = translatedHunks.map((h, i) => ({
      id: `${key}::${stamp}::${i}`,
      fileUri: uri,
      hunk: h,
      status: 'pending'
    }));
    // Apply both the baseline-coord drop set AND a defensive original-coord
    // overlap check (catches the rare partial-overlap case the baseline pass
    // missed when an accepted hunk sat in the way).
    entry.hunks = entry.hunks.filter((existing) => {
      if (droppedExistingIds.has(existing.id)) return false;
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
      entry.uri,
      entry.proposedUri,
      `BurstCode • ${path.basename(entry.uri.fsPath)} (Current ↔ Proposed)`
    );
  }

  async acceptHunk(hunkId: string): Promise<void> {
    // Two-phase lookup: an initial lookup gives us the file URI for locking;
    // we re-lookup INSIDE the lock to ensure the hunk still exists (another
    // concurrent decision could have flushed it out from under us between
    // the two steps). Run the status flip + flush under the file's lock so
    // an in-flight propose_edit can't race with the entry deletion.
    const initial = this.findHunkById(hunkId);
    if (!initial) return;
    await this.withFileLock(initial.file.uri.toString(), async () => {
      const target = this.findHunkById(hunkId);
      if (!target) return; // raced — already drained by another decision
      target.hunk.status = 'accepted';
      await this.flushFileIfDone(target.file);
    });
    this.emitDecision();
  }

  async rejectHunk(hunkId: string): Promise<void> {
    const initial = this.findHunkById(hunkId);
    if (!initial) return;
    await this.withFileLock(initial.file.uri.toString(), async () => {
      const target = this.findHunkById(hunkId);
      if (!target) return; // raced — already drained
      target.hunk.status = 'rejected';
      await this.flushFileIfDone(target.file);
    });
    this.emitDecision();
  }

  async acceptAll(): Promise<void> {
    // Per-file lock so concurrent propose_edits on different files keep
    // running in parallel; same-file ones serialize against the flush. The
    // `this.pending.has(...)` re-check inside the lock guards against a
    // file being drained by a per-hunk decision between our snapshot and
    // lock acquisition.
    const snapshot = Array.from(this.pending.values());
    await Promise.all(
      snapshot.map((file) =>
        this.withFileLock(file.uri.toString(), async () => {
          if (!this.pending.has(file.uri.toString())) return;
          for (const h of file.hunks) if (h.status === 'pending') h.status = 'accepted';
          await this.flushFileIfDone(file);
        })
      )
    );
    this.emitDecision();
  }

  async rejectAll(): Promise<void> {
    const snapshot = Array.from(this.pending.values());
    await Promise.all(
      snapshot.map((file) =>
        this.withFileLock(file.uri.toString(), async () => {
          if (!this.pending.has(file.uri.toString())) return;
          for (const h of file.hunks) if (h.status === 'pending') h.status = 'rejected';
          await this.flushFileIfDone(file);
        })
      )
    );
    this.emitDecision();
  }

  /**
   * Emit a pending-state change after a user decision. Only attaches a
   * `recentDecision` string when at least one file actually drained — per-hunk
   * accept/reject in a multi-hunk file otherwise produces a misleading
   * "no decisions recorded" flash and pollutes the system-note message log.
   */
  private emitDecision(): void {
    const summary = this.consumeDecisionSummary();
    this.emitState(summary ? { recentDecision: summary } : {});
  }

  /**
   * Snapshot and clear the decision journal accumulated since the last
   * `proposeEdits` call. Returns a short human-readable string the agent loop
   * feeds back to the model so it knows whether to retry, follow up, or stop,
   * or `undefined` when no file has fully drained since the last call.
   */
  consumeDecisionSummary(): string | undefined {
    const journal = this.decisionJournal;
    this.decisionJournal = [];
    if (journal.length === 0) return undefined;
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

  /**
   * If `uri` has pending edits, returns the current `modifiedContent` string
   * (i.e. the original file with all queued hunks applied). Returns `undefined`
   * when no pending edits exist for that file, so callers fall back to the
   * normal disk read path.
   */
  getPendingModifiedContent(uri: vscode.Uri): string | undefined {
    const key = uri.scheme === DiffPreview.scheme
      ? uri.with({ scheme: 'file', path: uri.path.replace(/\.proposed$/, '') }).toString()
      : uri.toString();
    return this.pending.get(key)?.modifiedContent;
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

  /**
   * Compute each queued hunk's range in MODIFIED-content coordinates (i.e.
   * the line numbers the model sees via read_file when the file has pending
   * edits). Mirrors the per-hunk delta math in `processFile`. Used by
   * read_file to surface explicit hunk boundaries in its output so the model
   * can target follow-up propose_edits without guessing where each pending
   * hunk starts and ends.
   *
   * Returns an empty array when the file has no pending entry.
   */
  getHunkRangesInModifiedCoords(
    uri: vscode.Uri
  ): Array<{ id: string; status: 'pending' | 'accepted' | 'rejected'; modStart: number; modEnd: number }> {
    const key = uri.scheme === DiffPreview.scheme
      ? uri.with({ scheme: 'file', path: uri.path.replace(/\.proposed$/, '') }).toString()
      : uri.toString();
    const entry = this.pending.get(key);
    if (!entry) return [];
    // Annotate in original-startLine ASC order so cumulative delta walks
    // monotonically (same convention as processFile). REJECTED hunks are
    // excluded — they were never applied to modifiedContent, so including
    // their delta would skew every subsequent hunk's reported modStart.
    const sorted = entry.hunks
      .filter((h) => h.status !== 'rejected')
      .slice()
      .sort((a, b) => a.hunk.startLine - b.hunk.startLine);
    let cum = 0;
    const out: Array<{ id: string; status: 'pending' | 'accepted' | 'rejected'; modStart: number; modEnd: number }> = [];
    for (const h of sorted) {
      const removed =
        h.hunk.startLine > h.hunk.endLine ? 0 : h.hunk.endLine - h.hunk.startLine + 1;
      const added = countAddedLines(h.hunk.newText);
      const modStart = h.hunk.startLine + cum;
      const modEnd = added === 0 ? modStart - 1 : modStart + added - 1;
      cum += added - removed;
      out.push({ id: h.id, status: h.status, modStart, modEnd });
    }
    return out;
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

/**
 * Count the number of lines `applyHunkToText` will substitute for a hunk's
 * newText. Mirrors the trailing-newline-drop in `applyHunkToText` so the
 * hunk-translation math in `processFile` stays consistent.
 */
function countAddedLines(newText: string): number {
  if (newText === '') return 0;
  const lines = newText.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && newText.endsWith('\n')) {
    lines.pop();
  }
  return lines.length;
}

function applyHunkToText(text: string, h: ProposedHunk, eol: string): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, h.startLine - 1);
  const end = Math.min(lines.length, h.endLine);
  // newText === '' means "no replacement content" (pure deletion or no-op
  // insertion). Without this branch, splitting '' yields [''] which would
  // splice an extra blank line into the result. countAddedLines already
  // reports 0 lines for '' — keep applyHunkToText consistent.
  const replacement = h.newText === '' ? [] : h.newText.split(/\r?\n/);
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
  // Pure deletion: extend the range to also consume one surrounding newline,
  // otherwise WorkspaceEdit.replace(range, '') leaves a stray blank line
  // where the deleted block used to be (because the line-bounding newlines
  // are NOT part of `[startCol=0, endCol=text.length]`). Prefer to consume
  // the FOLLOWING newline; if the deleted block reaches end-of-file, fall
  // back to the PRECEDING newline so we don't lose the file's trailing EOL.
  if (h.newText === '') {
    if (endLineIdx + 1 <= maxLine) {
      return new vscode.Range(start, 0, endLineIdx + 1, 0);
    }
    if (start > 0) {
      const prevEnd = doc.lineAt(start - 1).text.length;
      return new vscode.Range(
        start - 1,
        prevEnd,
        endLineIdx,
        doc.lineAt(endLineIdx).text.length
      );
    }
    // Deleting from the only line: fall through to the standard "(0, 0) to
    // (endLineIdx, lineEnd)" range — the resulting empty file matches what
    // the model asked for.
  }
  const endChar = doc.lineAt(endLineIdx).text.length;
  return new vscode.Range(start, 0, endLineIdx, endChar);
}

function ensureTrailingEol(text: string, eol: string, _insertOnly: boolean): string {
  // Normalize line endings to the document's EOL.
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, eol);
  return normalized;
}

/**
 * Split a string into "logical lines" the same way the rest of HunkApplier
 * does: split on either \r\n or \n, then drop a trailing empty entry that
 * comes from a terminating newline (so the line count matches what
 * applyHunkToText / countAddedLines treat as the file's line count).
 *
 * The empty string is treated as ZERO lines (consistent with countAddedLines)
 * — note that '\n' (one trailing newline) still counts as ONE empty line,
 * which matches "one empty line in the file".
 */
function splitLogicalLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\r?\n$/.test(text)) {
    lines.pop();
  }
  return lines;
}

/**
 * Resolve a hunk that carries an `oldText` anchor against `viewContent`:
 * find the unique line-aligned occurrence of oldText and rewrite the hunk's
 * (startLine, endLine) to match. Throws with a model-friendly message when
 * oldText is missing, ambiguous, or empty.
 *
 * Matching is two-tier. We first try an EXACT line equality match. If that
 * finds nothing, we retry with a whitespace-tolerant comparator (each line
 * compared after `trim()`) — this is the LLM's most common failure mode:
 * tabs vs spaces, wrong tab count, hallucinated extra leading whitespace,
 * stray trailing whitespace. A unique fuzzy match is accepted, and we then
 * auto-reindent `newText` by detecting the constant leading-whitespace
 * offset between the supplied oldText and the actually-matched file lines,
 * so the resulting diff still has the file's true indentation rather than
 * the LLM's mistaken one.
 *
 * - oldText must align to whole lines.
 * - When oldText appears multiple times, the caller's startLine acts as a
 *   disambiguation hint: only the match starting at that 1-indexed line is
 *   accepted; otherwise we ask the caller to add more context.
 * - To express a pure insertion via oldText, set oldText to the empty string
 *   (or a string that becomes empty after the trailing-newline drop) and
 *   provide startLine; we return startLine = endLine + 1 (insertion form).
 */
function resolveOldTextHunk(
  h: ProposedHunk,
  viewContent: string,
  filePath: string
): ProposedHunk {
  const rawOld = h.oldText ?? '';
  if (rawOld === '') {
    // Empty oldText is treated as an insertion at the caller-supplied
    // startLine. We require startLine for this case so the destination is
    // unambiguous. Note: splitLogicalLines('') returns [''] (one empty
    // string), not [], so we check the raw text directly here instead of
    // relying on the line array's length.
    if (!Number.isFinite(h.startLine) || h.startLine < 1) {
      throw new Error(
        `propose_edit on ${filePath}: oldText is empty and no usable startLine hint was provided. Either supply non-empty oldText, or use the legacy line-range form (startLine = endLine + 1 for insertion).`
      );
    }
    return { startLine: h.startLine, endLine: h.startLine - 1, newText: h.newText };
  }

  const oldLines = splitLogicalLines(rawOld);
  const viewLines = splitLogicalLines(viewContent);

  // Pass 1: exact line equality.
  let matches = findOldTextMatches(viewLines, oldLines, (a, b) => a === b);
  let matchMode: 'exact' | 'fuzzy' = 'exact';

  // Pass 2: whitespace-tolerant fallback. Compare lines after `.trim()`,
  // which catches the common case where the model reproduced indentation
  // imperfectly (tabs vs spaces, wrong tab count, stray trailing
  // whitespace). We only accept a UNIQUE fuzzy match below, so this can't
  // silently re-target an unrelated section that happens to share trimmed
  // content with oldText.
  if (matches.length === 0) {
    matches = findOldTextMatches(viewLines, oldLines, (a, b) => a.trim() === b.trim());
    matchMode = 'fuzzy';
  }

  if (matches.length === 0) {
    const preview = oldLines.slice(0, 2).join('\n');
    const more = oldLines.length > 2 ? ` ...(+${oldLines.length - 2} more lines)` : '';
    // Surface the actual file content at the model-supplied startLine so it
    // can compare side-by-side and self-correct on the next try, rather
    // than re-issuing the same wrong oldText in a tight loop.
    let actualSnippet = '';
    const hint = Number(h.startLine);
    if (Number.isFinite(hint) && hint >= 1) {
      const idx = hint - 1;
      const winSize = Math.min(Math.max(oldLines.length, 2), 8);
      const win = viewLines.slice(idx, Math.min(idx + winSize, viewLines.length));
      if (win.length > 0) {
        const numbered = win.map((l, i) => `${(idx + i + 1).toString().padStart(5)}\t${l}`).join('\n');
        actualSnippet = `\nActual file content starting at line ${hint}:\n${numbered}`;
      }
    }
    throw new Error(
      `propose_edit on ${filePath}: oldText not found in current view of file (tried exact match and whitespace-trimmed match). Re-read the file with read_file and copy the EXACT lines you want to replace.\nFirst lines of supplied oldText: "${preview}${more}".${actualSnippet}`
    );
  }

  let chosen: number;
  if (matches.length === 1) {
    chosen = matches[0];
  } else {
    // Disambiguate via the caller-supplied startLine hint.
    const hint = Number(h.startLine);
    if (Number.isFinite(hint) && hint >= 1 && matches.includes(hint - 1)) {
      chosen = hint - 1;
    } else {
      const matchLines = matches.map((m) => m + 1).join(', ');
      throw new Error(
        `propose_edit on ${filePath}: oldText is not unique (${matches.length} matches at lines ${matchLines}). Add more context lines to oldText to make it unique, or set startLine to one of those line numbers as a tie-breaker.`
      );
    }
  }

  // Fuzzy mode: try to detect a constant leading-whitespace offset between
  // the supplied oldText and the actually-matched file lines, and apply
  // that offset to newText. This produces a diff that respects the file's
  // real indentation even when the model hallucinated extra tabs/spaces.
  let newText = h.newText;
  if (matchMode === 'fuzzy') {
    const matchedFileLines = viewLines.slice(chosen, chosen + oldLines.length);
    const reindented = tryReindentByPrefix(newText, oldLines, matchedFileLines);
    if (reindented !== null) newText = reindented;
  }

  return {
    startLine: chosen + 1,
    endLine: chosen + oldLines.length,
    newText
  };
}

/**
 * Sliding-window search for `oldLines` inside `viewLines`. Returns 0-indexed
 * start positions of every match according to `eq`. Empty `oldLines` is
 * treated as "no matches" (callers handle the empty-oldText case earlier
 * via the insertion branch).
 */
function findOldTextMatches(
  viewLines: string[],
  oldLines: string[],
  eq: (a: string, b: string) => boolean
): number[] {
  const matches: number[] = [];
  if (oldLines.length === 0) return matches;
  outer: for (let i = 0; i + oldLines.length <= viewLines.length; i++) {
    for (let j = 0; j < oldLines.length; j++) {
      if (!eq(viewLines[i + j], oldLines[j])) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

/**
 * When fuzzy-matching landed a hunk, try to detect a constant leading-
 * whitespace offset between every non-blank line of `oldLines` and its
 * counterpart in `fileLines`, and translate `newText`'s leading prefix
 * accordingly. Returns the rewritten newText, or `null` when no consistent
 * offset exists (in which case the caller falls back to the model's
 * newText verbatim).
 *
 * Heuristic: every non-blank oldLine must have its file counterpart end in
 * the SAME suffix (i.e. they differ only in their leading-whitespace
 * prefix). The shared old-prefix and the shared new-prefix are then
 * substituted at the start of every newText line that begins with the
 * old-prefix. Lines in newText that don't start with the old-prefix are
 * left alone — that catches the common case where newText extends or
 * shrinks beyond oldText's base indent and the LLM consistently used the
 * same (incorrect) prefix throughout.
 */
function tryReindentByPrefix(
  newText: string,
  oldLines: string[],
  fileLines: string[]
): string | null {
  if (oldLines.length !== fileLines.length || oldLines.length === 0) return null;
  let oldPrefix: string | null = null;
  let newPrefix: string | null = null;
  for (let i = 0; i < oldLines.length; i++) {
    const o = oldLines[i];
    const f = fileLines[i];
    if (o.trim() === '' || f.trim() === '') continue;
    const oLW = leadingWs(o);
    const fLW = leadingWs(f);
    // Both must end in the same non-whitespace content for the offset to
    // be meaningful. (We already passed the trimmed-equality match, so
    // this check is technically redundant, but it guards against future
    // comparator changes.)
    if (o.slice(oLW.length) !== f.slice(fLW.length)) return null;
    if (oldPrefix === null) {
      oldPrefix = oLW;
      newPrefix = fLW;
    } else {
      // Require the offset to be constant across all anchored lines —
      // otherwise we have no reliable single substitution.
      if (oLW !== oldPrefix || fLW !== newPrefix) return null;
    }
  }
  if (oldPrefix === null || newPrefix === null) return null;
  if (oldPrefix === newPrefix) return null;
  return reindentTextPrefix(newText, oldPrefix, newPrefix);
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * Replace a leading `fromPrefix` with `toPrefix` at the start of every line
 * in `text`. Lines that don't start with fromPrefix are left untouched.
 * EOL style (\n vs \r\n) is preserved.
 */
function reindentTextPrefix(text: string, fromPrefix: string, toPrefix: string): string {
  if (fromPrefix === toPrefix) return text;
  if (fromPrefix === '') {
    // Empty fromPrefix would otherwise prepend toPrefix to every line,
    // including blank ones. Skip — the caller's `oldPrefix === null`
    // guard already covers this case for fuzzy matches.
    return text;
  }
  const parts = text.split(/(\r?\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].startsWith(fromPrefix)) {
      parts[i] = toPrefix + parts[i].slice(fromPrefix.length);
    }
  }
  return parts.join('');
}
