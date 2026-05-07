import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
import {
  OutlineOptions,
  OutlineResult,
  buildWorkspaceOutline,
  defaultOutlineOptions
} from './WorkspaceOutline';

/**
 * Workspace-level context cache.
 *
 * Goals:
 *  - Walk the filesystem ONCE at activation (pre-warm) instead of on every
 *    chat turn. The outline is then served from memory.
 *  - Stay fresh by listening to VS Code file events + a low-level FS watcher
 *    (covers external mutations like `git pull`, `npm install`).
 *  - Stay cheap: content edits do NOT invalidate the outline (it only
 *    encodes which files exist, not what's inside them). Events that occur
 *    entirely under excluded directories (node_modules, .git, dist, ...)
 *    are ignored so a `npm install` storm doesn't thrash the cache.
 *
 * The cache is intentionally LAZY-REBUILT: invalidation just clears the
 * cached value, the next `getOutline()` call rebuilds it. This collapses
 * bursts of file events into a single rebuild paid for by the next consumer.
 */
export class WorkspaceIndex implements vscode.Disposable {
  private cached?: OutlineResult;
  private inflight?: Promise<OutlineResult>;
  private disposables: vscode.Disposable[] = [];
  private readonly excludeDirs: Set<string>;
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires whenever the cached outline becomes stale (debounced consumers welcome). */
  readonly onDidInvalidate: vscode.Event<void> = this.emitter.event;

  constructor(private readonly logger: Logger) {
    this.excludeDirs = new Set(defaultOutlineOptions.excludeDirs);
    // Allow user-configured extra excludes to also suppress watcher noise.
    const extra = vscode.workspace
      .getConfiguration('burstcode.context')
      .get<string[]>('outlineExtraExcludes');
    if (Array.isArray(extra)) extra.forEach((d) => this.excludeDirs.add(d));

    // FS watcher for create/delete only; ignoreChange=true so content edits
    // (which don't affect the outline) don't trigger work.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.maybeInvalidate(uri.fsPath)),
      watcher.onDidDelete((uri) => this.maybeInvalidate(uri.fsPath)),
      vscode.workspace.onDidCreateFiles((e) =>
        e.files.forEach((f) => this.maybeInvalidate(f.fsPath))
      ),
      vscode.workspace.onDidDeleteFiles((e) =>
        e.files.forEach((f) => this.maybeInvalidate(f.fsPath))
      ),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach((f) => {
          this.maybeInvalidate(f.oldUri.fsPath);
          this.maybeInvalidate(f.newUri.fsPath);
        })
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate('workspace folders changed')),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('burstcode.context')) this.invalidate('context config changed');
      })
    );
  }

  /**
   * Build the outline immediately so the cache is hot by the time the user
   * sends their first prompt. Fire-and-forget — any error is logged and the
   * lazy path will retry on demand.
   */
  prewarm(): void {
    void this.getOutline().catch((err) =>
      this.logger.warn('WorkspaceIndex prewarm failed', String(err))
    );
  }

  async getOutline(): Promise<OutlineResult> {
    if (this.cached) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Force an immediate rebuild (used after an explicit external change). */
  async refresh(): Promise<OutlineResult> {
    this.invalidate('manual refresh');
    return this.getOutline();
  }

  private invalidate(reason: string): void {
    if (!this.cached) return;
    this.cached = undefined;
    this.logger.debug(`WorkspaceIndex invalidated: ${reason}`);
    this.emitter.fire();
  }

  /** Suppress events whose path lives entirely inside an excluded directory. */
  private maybeInvalidate(fsPath: string): void {
    const segments = fsPath.split(/[\\/]/);
    if (segments.some((s) => this.excludeDirs.has(s))) return;
    this.invalidate(`fs change: ${fsPath}`);
  }

  private async build(): Promise<OutlineResult> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      const empty: OutlineResult = { text: '', truncated: false, dirsVisited: 0 };
      this.cached = empty;
      return empty;
    }
    const overrides = this.readOverrides();
    try {
      const result = await buildWorkspaceOutline(root, overrides);
      this.cached = result;
      this.logger.debug(
        `WorkspaceIndex built outline (${result.text.length} chars, ${result.dirsVisited} dirs${result.truncated ? ', truncated' : ''})`
      );
      return result;
    } catch (err) {
      this.logger.warn('WorkspaceIndex build failed', String(err));
      const fallback: OutlineResult = { text: '', truncated: false, dirsVisited: 0 };
      // Don't cache failures — let the next call retry.
      return fallback;
    }
  }

  private readOverrides(): Partial<OutlineOptions> {
    const ctxCfg = vscode.workspace.getConfiguration('burstcode.context');
    const overrides: Partial<OutlineOptions> = {};
    const baseDepth = ctxCfg.get<number>('outlineBaseDepth');
    if (typeof baseDepth === 'number' && baseDepth > 0) overrides.baseDepth = baseDepth;
    const srcDepth = ctxCfg.get<number>('outlineSrcDepth');
    if (typeof srcDepth === 'number' && srcDepth > 0) overrides.srcDepth = srcDepth;
    const maxBytes = ctxCfg.get<number>('outlineMaxBytes');
    if (typeof maxBytes === 'number' && maxBytes > 0) overrides.maxBytes = maxBytes;
    const extraExcludes = ctxCfg.get<string[]>('outlineExtraExcludes');
    if (Array.isArray(extraExcludes) && extraExcludes.length > 0) {
      overrides.excludeDirs = new Set(extraExcludes);
    }
    return overrides;
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
