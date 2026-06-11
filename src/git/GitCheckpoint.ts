import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../util/Logger';
type GitignoreRule = {
  pattern: string;
  directoryOnly: boolean;
  anchored: boolean;
  basenameOnly: boolean;
};


export interface CheckpointInfo {
  ref: string;
  sha: string;
  label: string;
  /** ms since epoch */
  createdAt: number;
  isFileBased?: boolean;
}

/**
 * Creates lightweight rollback points by snapshotting the working tree into
 * `.burstcode/checkpoints/<timestamp>/` as plain files.
 *
 * This approach is completely independent of the project's git repository —
 * it works whether or not the workspace has a .git directory.
 *
 * Old sessions may contain git-based refs (`refs/burstcode/checkpoints/…`);
 * those are still readable and restorable for backward compatibility.
 */
export class GitCheckpoint {
  /** Prefix for legacy git-based checkpoint refs (backward compat only). */
  private static readonly GIT_REF_PREFIX = 'refs/burstcode/checkpoints/';
  private static readonly FILE_REF_PREFIX = 'file:';
  private static readonly CHECKPOINT_DIR = '.burstcode/checkpoints';
  private static readonly MAX_FILE_SIZE = 1024 * 1024;
  private static readonly IO_CONCURRENCY = 16;
  /** Force a full snapshot once a delta chain reaches this depth (caps restore cost). */
  private static readonly MAX_DELTA_CHAIN = 20;
  /** Keep roughly this many checkpoints; older whole segments are pruned past it. */
  private static readonly MAX_CHECKPOINTS = 100;

  private static readonly BINARY_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.psd', '.ai',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.exe', '.dll', '.so', '.dylib', '.pdb', '.class', '.o', '.a', '.lib', '.node',
    '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2', '.xz', '.nupkg',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.aac', '.webm',
    '.db', '.sqlite', '.sqlite3', '.mdf', '.ldf',
    '.pdf', '.doc', '.xls', '.ppt',
  ]);

  private static readonly SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'target', 'bin', 'obj',
    'out', '__pycache__', 'vendor',
  ]);

  /** Hot cache for the last `resolveCheckpointChain` result, keyed by ref.
   *  Avoids redundant chain-resolution when `listAffectedFiles` and
   *  `restoreFileCheckpoint` operate on the same ref back-to-back. */
  private _resolvedSourceMapCache: Map<string, string> | null = null;
  private _resolvedSourceMapRef = '';

  constructor(private readonly logger: Logger) {}

  /**
   * Normalize a set of workspace-relative paths to POSIX form (forward
   * slashes, no leading "./") so they compare cleanly against snapshot keys
   * regardless of the OS path separator the caller used.
   */
  private static normalizePathSet(paths: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const p of paths) {
      if (!p) continue;
      out.add(GitCheckpoint.normalizeRelativePath(p));
    }
    return out;
  }

  private static normalizeRelativePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  }

  private async readGitignoreRules(root: string): Promise<GitignoreRule[]> {
    let raw = '';
    try {
      raw = await fs.promises.readFile(path.join(root, '.gitignore'), 'utf-8');
    } catch {
      return [];
    }

    const rules: GitignoreRule[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      let pattern = trimmed.replace(/\\/g, '/');
      const directoryOnly = pattern.endsWith('/');
      pattern = pattern.replace(/\/+$/, '');
      const anchored = pattern.startsWith('/');
      pattern = pattern.replace(/^\/+/, '');
      if (!pattern) continue;
      rules.push({ pattern, directoryOnly, anchored, basenameOnly: !pattern.includes('/') });
    }
    return rules;
  }

  private static isIgnoredByGitignore(relativePath: string, rules: GitignoreRule[]): boolean {
    const rel = GitCheckpoint.normalizeRelativePath(relativePath);
    if (!rel || rel === '.gitignore') return false;
    if (rel === '.burstcode/checkpoints' || rel.startsWith('.burstcode/checkpoints/')) return true;
    return rules.some((r) => GitCheckpoint.gitignoreRuleMatches(rel, r));
  }

  private static gitignoreRuleMatches(rel: string, rule: GitignoreRule): boolean {
    if (rule.basenameOnly) {
      const parts = rel.split('/');
      return rule.directoryOnly
        ? parts.some((p, i) => GitCheckpoint.gitignoreSegmentMatches(p, rule.pattern) && i < parts.length - 1)
        : parts.some((p) => GitCheckpoint.gitignoreSegmentMatches(p, rule.pattern));
    }

    const candidates = rule.anchored ? [rel] : GitCheckpoint.pathSuffixes(rel);
    return candidates.some((candidate) => {
      if (rule.directoryOnly) {
        return candidate === rule.pattern || candidate.startsWith(`${rule.pattern}/`);
      }
      return GitCheckpoint.gitignorePathMatches(candidate, rule.pattern);
    });
  }

  private static pathSuffixes(rel: string): string[] {
    const parts = rel.split('/');
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('/'));
    return out;
  }

  private static gitignorePathMatches(rel: string, pattern: string): boolean {
    const relParts = rel.split('/');
    const patParts = pattern.split('/');
    if (relParts.length !== patParts.length) return false;
    return patParts.every((p, i) => GitCheckpoint.gitignoreSegmentMatches(relParts[i], p));
  }

  private static gitignoreSegmentMatches(text: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '').test(text);
  }

  isEnabled(): boolean {
    return (
      vscode.workspace.getConfiguration('burstcode.git').get<boolean>('autoCheckpoint') ?? true
    );
  }

  /** No-op — kept for API compatibility with extension.ts subscription. */
  invalidate(): void {}

  /** Best-effort git repo root detection, used only for backward-compat restore of old git refs. */
  private async tryRepoRoot(): Promise<string | undefined> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return undefined;
    try {
      const out = (await this.run(ws, ['rev-parse', '--show-toplevel'])).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  }

  private async workspaceRoot(): Promise<string | undefined> {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getCheckpointDir(root: string): string {
    return path.join(root, GitCheckpoint.CHECKPOINT_DIR);
  }

  private async ensureCheckpointDir(root: string): Promise<void> {
    await fs.promises.mkdir(this.getCheckpointDir(root), { recursive: true });
  }

  /**
   * Runs async tasks with bounded concurrency (worker-pool pattern).
   * Safer than Promise.all on large file sets — avoids exhausting OS file handles.
   */
  private static async runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    if (tasks.length === 0) return [];
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Phase 1 of snapshot: recursively collect candidate file paths.
   * Subdirectories are walked in parallel (Promise.all per level).
   */
  private async gatherCandidates(
    currentDir: string,
    baseDir: string,
    ignoreRules: GitignoreRule[]
  ): Promise<Array<{ fullPath: string; relativePath: string }>> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const fileCandidates: Array<{ fullPath: string; relativePath: string }> = [];
    const subdirPromises: Promise<Array<{ fullPath: string; relativePath: string }>>[] = [];

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = GitCheckpoint.normalizeRelativePath(path.relative(baseDir, fullPath));
      if (GitCheckpoint.isIgnoredByGitignore(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !GitCheckpoint.SKIP_DIRS.has(entry.name)) {
          subdirPromises.push(this.gatherCandidates(fullPath, baseDir, ignoreRules));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!GitCheckpoint.BINARY_EXTENSIONS.has(ext)) {
          fileCandidates.push({ fullPath, relativePath });
        }
      }
    }

    const subdirResults = await Promise.all(subdirPromises);
    for (const sub of subdirResults) {
      for (const f of sub) fileCandidates.push(f);
    }
    return fileCandidates;
  }

  /**
   * Snapshot the working tree into `.burstcode/checkpoints/<ts>/` and return
   * the new checkpoint info. THROWS with a descriptive message on failure.
   *
   * Checkpoints are stored as plain files, completely independent of the
   * project's git repository. Works whether or not the workspace has .git.
   *
   * Performance: three parallel phases —
   *   1. parallel directory traversal to collect candidate paths
   *   2. concurrent file reads (pool of IO_CONCURRENCY)
   *   3. concurrent checkpoint writes (pool of IO_CONCURRENCY)
   */
  async createCheckpoint(label: string): Promise<CheckpointInfo> {
    if (!this.isEnabled()) {
      const msg = 'burstcode.git.autoCheckpoint is disabled';
      this.logger.warn(`Checkpoint skipped: ${msg} — rollback button will be unavailable.`);
      throw new Error(msg);
    }
    return this.createFileCheckpoint(label);
  }

  private async createFileCheckpoint(label: string): Promise<CheckpointInfo> {
    const wsRoot = await this.workspaceRoot();
    if (!wsRoot) {
      const msg = 'no workspace folder available';
      this.logger.warn(`Checkpoint skipped: ${msg}`);
      throw new Error(msg);
    }

    await this.ensureCheckpointDir(wsRoot);
    const createdAt = Date.now();
    const ref = `${GitCheckpoint.FILE_REF_PREFIX}${createdAt}`;
    const checkpointDir = path.join(this.getCheckpointDir(wsRoot), createdAt.toString());
    await fs.promises.mkdir(checkpointDir, { recursive: true });

    // Pick the most recent existing checkpoint as a delta base. Only files
    // modified since the base are snapshotted; the rest are reconstructed from
    // the base chain at restore time. This keeps each checkpoint small instead
    // of re-copying the whole tree every time. The chain is periodically
    // re-based with a full snapshot to cap restore cost (MAX_DELTA_CHAIN).
    const base = await this.findLatestFileCheckpoint(wsRoot, createdAt);
    const useDelta = base !== null && base.chainDepth + 1 < GitCheckpoint.MAX_DELTA_CHAIN;
    const sinceMs = useDelta ? base!.createdAt : 0;
    const baseRef = useDelta ? base!.ref : undefined;
    const chainDepth = useDelta ? base!.chainDepth + 1 : 0;

    try {
      // Phase 1: parallel directory walk — collect candidate paths
      const ignoreRules = await this.readGitignoreRules(wsRoot);
      const candidates = await this.gatherCandidates(wsRoot, wsRoot, ignoreRules);

      // Phase 2: concurrent file reads. In delta mode, unchanged files (mtime
      // older than the base checkpoint) are skipped before reading — that is
      // where the I/O savings come from. `>=` errs toward capturing a file
      // rather than missing an edit made right at the base boundary.
      const MAX = GitCheckpoint.MAX_FILE_SIZE;
      const readTasks = candidates.map(c => async () => {
        try {
          const stats = await fs.promises.stat(c.fullPath);
          if (stats.size > MAX) {
            this.logger.debug(`Skipping large file ${c.relativePath} (${stats.size} bytes)`);
            return null;
          }
          if (sinceMs > 0 && stats.mtimeMs < sinceMs) {
            return null;
          }
          const content = await fs.promises.readFile(c.fullPath, 'utf-8');
          return { relativePath: c.relativePath, content };
        } catch {
          return null;
        }
      });
      const readResults = await GitCheckpoint.runPool(readTasks, GitCheckpoint.IO_CONCURRENCY);
      const files = readResults.filter((f): f is { relativePath: string; content: string } => f !== null);

      // Tombstones: files the base chain still carries but that no longer exist
      // in the working tree. Recorded so restore drops them instead of
      // resurrecting deleted files (manifest-only walk — no blob reads).
      let deleted: string[] = [];
      if (baseRef) {
        const baseEffective = await this.resolveCheckpointChain(wsRoot, baseRef, new Set());
        const currentPaths = new Set(candidates.map(c => c.relativePath));
        deleted = [...baseEffective.keys()].filter(p => !currentPaths.has(p) || GitCheckpoint.isIgnoredByGitignore(p, ignoreRules));
      }

      // Write manifest (tiny, no need to parallelize). `baseRef` lets restore
      // walk the delta chain; undefined marks a full snapshot.
      const manifest = { label, createdAt, baseRef, chainDepth, files: files.map(f => ({ relativePath: f.relativePath })), deleted };
      await fs.promises.writeFile(path.join(checkpointDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Phase 3: concurrent checkpoint file writes
      const writeTasks = files.map(f => async () => {
        const encoded = f.relativePath.replace(/[^a-zA-Z0-9._-]/g, '_');
        await fs.promises.writeFile(path.join(checkpointDir, encoded), f.content);
      });
      await GitCheckpoint.runPool(writeTasks, GitCheckpoint.IO_CONCURRENCY);

      this.logger.info('Checkpoint created', { ref, label, fileCount: files.length, baseRef: baseRef ?? null, chainDepth });

      // Bound disk usage by pruning the oldest whole segments past the cap.
      // Best-effort: a prune failure must not fail checkpoint creation.
      try {
        await this.pruneOldCheckpoints(wsRoot);
      } catch (err) {
        this.logger.debug(`Checkpoint prune skipped: ${String(err)}`);
      }

      return { ref, sha: '', label, createdAt, isFileBased: true };
    } catch (err) {
      try { await fs.promises.rm(checkpointDir, { recursive: true, force: true }); } catch {}
      const msg = `checkpoint failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(msg);
      throw new Error(msg);
    }
  }

  /**
   * Most recent file-based checkpoint strictly older than `beforeMs`, together
   * with its delta-chain depth. Used to pick a base for incremental snapshots.
   * Directories without a readable manifest are ignored (not usable as a base).
   */
  private async findLatestFileCheckpoint(
    wsRoot: string,
    beforeMs: number
  ): Promise<{ ref: string; createdAt: number; chainDepth: number } | null> {
    const dir = this.getCheckpointDir(wsRoot);
    if (!fs.existsSync(dir)) return null;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    // Inspect candidates newest-first so we read at most one manifest in the
    // common case.
    const timestamps = entries
      .filter(e => e.isDirectory())
      .map(e => Number(e.name))
      .filter(ts => Number.isFinite(ts) && ts < beforeMs)
      .sort((a, b) => b - a);

    for (const ts of timestamps) {
      const manifestPath = path.join(dir, ts.toString(), 'manifest.json');
      try {
        const m = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
        const chainDepth = typeof m.chainDepth === 'number' ? m.chainDepth : 0;
        return { ref: `${GitCheckpoint.FILE_REF_PREFIX}${ts}`, createdAt: ts, chainDepth };
      } catch {
        // No valid manifest — skip and try the next-oldest.
      }
    }
    return null;
  }

  /**
   * Delete every file-based checkpoint whose timestamp is strictly greater than
   * `afterMs`. Used on rollback to discard forward history. Chain-safe: a
   * checkpoint's base is always older than itself, so removing newer ones can
   * never orphan a checkpoint we keep. Returns the number deleted.
   */
  private async deleteForwardCheckpoints(wsRoot: string, afterMs: number): Promise<number> {
    const dir = this.getCheckpointDir(wsRoot);
    if (!fs.existsSync(dir)) return 0;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const ts = Number(e.name);
      if (!Number.isFinite(ts) || ts <= afterMs) continue;
      try {
        await fs.promises.rm(path.join(dir, e.name), { recursive: true, force: true });
        deleted++;
      } catch (err) {
        this.logger.debug(`Failed to delete forward checkpoint ${e.name}: ${String(err)}`);
      }
    }
    return deleted;
  }

  /** List file-based checkpoints (oldest-first) with the base ref each declares. */
  private async listFileCheckpointMeta(
    wsRoot: string
  ): Promise<Array<{ ts: number; ref: string; baseRef?: string }>> {
    const dir = this.getCheckpointDir(wsRoot);
    if (!fs.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const metas: Array<{ ts: number; ref: string; baseRef?: string }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const ts = Number(e.name);
      if (!Number.isFinite(ts)) continue;
      let baseRef: string | undefined;
      try {
        const m = JSON.parse(await fs.promises.readFile(path.join(dir, e.name, 'manifest.json'), 'utf-8'));
        baseRef = typeof m.baseRef === 'string' ? m.baseRef : undefined;
      } catch {
        // Unreadable manifest — treat as a standalone full snapshot (own segment).
        baseRef = undefined;
      }
      metas.push({ ts, ref: `${GitCheckpoint.FILE_REF_PREFIX}${ts}`, baseRef });
    }
    metas.sort((a, b) => a.ts - b.ts);
    return metas;
  }

  /**
   * Prune the oldest whole delta-chain segments once the checkpoint count
   * exceeds MAX_CHECKPOINTS. A segment starts at a full snapshot (no baseRef)
   * and runs until the next one; segments are dependency-isolated, so deleting
   * an entire older segment can never break a newer chain. The newest segment
   * is always kept. Cheap early-out when under the cap.
   */
  private async pruneOldCheckpoints(wsRoot: string): Promise<void> {
    const cap = GitCheckpoint.MAX_CHECKPOINTS;
    const dir = this.getCheckpointDir(wsRoot);
    if (!fs.existsSync(dir)) return;

    // Cheap count first — only pay for manifest reads when actually over cap.
    let dirCount = 0;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      dirCount = entries.filter(e => e.isDirectory()).length;
    } catch {
      return;
    }
    if (dirCount <= cap) return;

    const metas = await this.listFileCheckpointMeta(wsRoot);

    // Group into segments: a checkpoint with no baseRef (or the very first one)
    // begins a new segment.
    const segments: Array<Array<{ ts: number }>> = [];
    for (const m of metas) {
      if (!m.baseRef || segments.length === 0) {
        segments.push([{ ts: m.ts }]);
      } else {
        segments[segments.length - 1].push({ ts: m.ts });
      }
    }

    let total = metas.length;
    while (total > cap && segments.length > 1) {
      const seg = segments.shift()!;
      for (const cp of seg) {
        try {
          await fs.promises.rm(path.join(dir, cp.ts.toString()), { recursive: true, force: true });
        } catch (err) {
          this.logger.debug(`Failed to prune checkpoint ${cp.ts}: ${String(err)}`);
        }
      }
      total -= seg.length;
      this.logger.info('Pruned old checkpoint segment', { count: seg.length, remaining: total });
    }
  }

  /**
   * Resolve the set of workspace-relative file paths whose on-disk content
   * would actually CHANGE if `ref` were restored right now. Used to preview
   * the rollback in the confirmation dialog so the user knows exactly which
   * files revert. Files whose current content already matches the checkpoint
   * blob are omitted (restoring them is a no-op). Returns an empty array for
   * legacy git refs or when nothing resolves.
   */
  async listAffectedFiles(ref: string, allowedPaths?: Set<string>): Promise<string[]> {
    if (!ref || !ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) return [];
    const wsRoot = await this.workspaceRoot();
    if (!wsRoot) return [];
    let sourceMap: Map<string, string>;
    try {
      sourceMap = await this.resolveCheckpointChain(wsRoot, ref, new Set());
    } catch {
      return [];
    }
    // When the caller scopes the rollback to the current session's files, the
    // preview must list ONLY those files — never files owned by another tab.
    const scope = allowedPaths ? GitCheckpoint.normalizePathSet(allowedPaths) : null;
    const changed: string[] = [];
    const entries = scope
      ? Array.from(sourceMap.entries()).filter(([rel]) => scope.has(rel.replace(/\\/g, '/')))
      : Array.from(sourceMap.entries());
    const checks = entries.map(([relativePath, sourcePath]) => async () => {
      try {
        const snapshot = await fs.promises.readFile(sourcePath, 'utf-8');
        let current: string | null = null;
        try {
          current = await fs.promises.readFile(path.join(wsRoot, relativePath), 'utf-8');
        } catch {
          current = null; // file missing now → restore re-creates it (a change)
        }
        if (current !== snapshot) changed.push(relativePath);
      } catch {
        /* unreadable snapshot blob — skip */
      }
    });
    await GitCheckpoint.runPool(checks, GitCheckpoint.IO_CONCURRENCY);
    // Session-created files (written this session, absent from the snapshot)
    // will be DELETED by a scoped rollback, so surface them in the preview too.
    if (scope) {
      for (const rel of scope) {
        const inSnapshot = sourceMap.has(rel) || sourceMap.has(rel.replace(/\//g, path.sep));
        if (inSnapshot) continue;
        try {
          await fs.promises.access(path.join(wsRoot, rel));
          if (!changed.includes(rel)) changed.push(rel);
        } catch {
          /* not on disk → nothing to delete */
        }
      }
    }
    changed.sort();
    return changed;
  }

  /**
   * Return the snapshot (pre-prompt) content of a single file as captured by
   * the given file-based checkpoint, or null when the file is NOT part of the
   * checkpoint. A null result means the file did not exist at checkpoint time
   * (it was created during/after the prompt) and will therefore be DELETED by
   * a rollback rather than reverted — callers can use this to show an
   * "empty ↔ current" (will-be-deleted) diff.
   */
  async getCheckpointFileSnapshot(ref: string, relativePath: string): Promise<string | null> {
    if (!ref || !ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) return null;
    const wsRoot = await this.workspaceRoot();
    if (!wsRoot) return null;
    let sourceMap: Map<string, string>;
    try {
      sourceMap = await this.resolveCheckpointChain(wsRoot, ref, new Set());
    } catch {
      return null;
    }
    const norm = relativePath.replace(/\\/g, '/');
    const blobPath = sourceMap.get(relativePath) ?? sourceMap.get(norm);
    if (!blobPath) return null;
    try {
      return await fs.promises.readFile(blobPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async refExists(ref: string): Promise<boolean> {
    if (!ref) return false;

    if (ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) {
      const wsRoot = await this.workspaceRoot();
      if (!wsRoot) return false;
      const timestamp = ref.slice(GitCheckpoint.FILE_REF_PREFIX.length);
      const checkpointDir = path.join(this.getCheckpointDir(wsRoot), timestamp);
      return fs.existsSync(checkpointDir);
    }

    // Legacy: git-based refs from old sessions
    if (ref.startsWith(GitCheckpoint.GIT_REF_PREFIX)) {
      const root = await this.tryRepoRoot();
      if (!root) return false;
      try {
        const out = (await this.run(root, ['rev-parse', '--verify', '--quiet', ref])).trim();
        return out.length > 0;
      } catch {
        return false;
      }
    }

    return false;
  }

  async listCheckpoints(): Promise<CheckpointInfo[]> {
    const infos: CheckpointInfo[] = [];

    // List file-based checkpoints (primary)
    const wsRoot = await this.workspaceRoot();
    if (wsRoot) {
      const checkpointDir = this.getCheckpointDir(wsRoot);
      if (fs.existsSync(checkpointDir)) {
        try {
          const entries = await fs.promises.readdir(checkpointDir, { withFileTypes: true });
          const manifestTasks = entries
            .filter(e => e.isDirectory())
            .map(e => async () => {
              const manifestPath = path.join(checkpointDir, e.name, 'manifest.json');
              try {
                const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
                return {
                  ref: `${GitCheckpoint.FILE_REF_PREFIX}${e.name}`,
                  sha: '',
                  label: manifest.label || '',
                  createdAt: manifest.createdAt || 0,
                  isFileBased: true
                } as CheckpointInfo;
              } catch {
                return null;
              }
            });
          const results = await GitCheckpoint.runPool(manifestTasks, GitCheckpoint.IO_CONCURRENCY);
          for (const r of results) { if (r) infos.push(r); }
        } catch (err) {
          this.logger.warn('Failed to list checkpoints', String(err));
        }
      }
    }

    // List legacy git-based checkpoints (backward compat)
    const root = await this.tryRepoRoot();
    if (root) {
      try {
        const out = await this.run(root, [
          'for-each-ref',
          '--format=%(refname)%09%(objectname)%09%(subject)',
          '--sort=-refname',
          GitCheckpoint.GIT_REF_PREFIX
        ]);
        for (const line of out.split(/\r?\n/).filter(Boolean)) {
          const [ref, sha, ...rest] = line.split('\t');
          if (!ref || !sha) continue;
          const tsStr = ref.slice(GitCheckpoint.GIT_REF_PREFIX.length);
          const createdAt = Number(tsStr);
          infos.push({
            ref, sha,
            label: rest.join('\t').replace(/^BurstCode checkpoint:\s*/, ''),
            createdAt: Number.isFinite(createdAt) ? createdAt : 0
          });
        }
      } catch (err) {
        this.logger.debug('Failed to list legacy git checkpoints', String(err));
      }
    }

    return infos.sort((a, b) => b.createdAt - a.createdAt);
  }

  async restoreCheckpoint(ref: string, allowedPaths?: Set<string>): Promise<boolean> {
    if (ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) {
      return this.restoreFileCheckpoint(ref, allowedPaths);
    }
    if (ref.startsWith(GitCheckpoint.GIT_REF_PREFIX)) {
      return this.restoreGitCheckpoint(ref);
    }
    vscode.window.showErrorMessage('BurstCode: unknown checkpoint ref format.');
    return false;
  }

  private async restoreFileCheckpoint(ref: string, allowedPaths?: Set<string>): Promise<boolean> {
    const wsRoot = await this.workspaceRoot();
    if (!wsRoot) {
      vscode.window.showErrorMessage('BurstCode: no workspace folder available.');
      return false;
    }

    const timestamp = ref.slice(GitCheckpoint.FILE_REF_PREFIX.length);
    const checkpointDir = path.join(this.getCheckpointDir(wsRoot), timestamp);

    if (!fs.existsSync(checkpointDir)) {
      vscode.window.showErrorMessage('BurstCode: checkpoint directory not found.');
      return false;
    }

    const manifestPath = path.join(checkpointDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      vscode.window.showErrorMessage('BurstCode: checkpoint manifest not found.');
      return false;
    }

    try {
      // Compose the full snapshot by walking the delta chain (base → … →
      // target). Each entry maps a workspace-relative path to the stored
      // checkpoint blob it should be restored from; newer checkpoints win.
      const fullSourceMap = this._resolvedSourceMapRef === ref && this._resolvedSourceMapCache
        ? new Map(this._resolvedSourceMapCache)
        : await this.resolveCheckpointChain(wsRoot, ref, new Set());

      // SESSION-SCOPED ROLLBACK: when the caller passes `allowedPaths` (the set
      // of files the current chat session actually wrote), restrict BOTH the
      // restore and the orphan-deletion to those files. Files changed by another
      // chat tab, a background run, or by hand are left exactly as they are — a
      // rollback must never clobber work it did not produce. With no scope set
      // we fall back to the legacy whole-tree behaviour (e.g. the quick-pick
      // "Restore Checkpoint" command, which is intentionally global).
      const scope = allowedPaths ? GitCheckpoint.normalizePathSet(allowedPaths) : null;
      const sourceMap = scope
        ? new Map(
            Array.from(fullSourceMap.entries()).filter(([rel]) =>
              scope.has(rel.replace(/\\/g, '/'))
            )
          )
        : fullSourceMap;

      // Concurrent restore
      const skippedPaths: string[] = [];

      const restoreTasks = Array.from(sourceMap.entries()).map(([relativePath, sourcePath]) => async () => {
        const originalPath = path.join(wsRoot, relativePath);
        try {
          const content = await fs.promises.readFile(sourcePath, 'utf-8');
          await fs.promises.mkdir(path.dirname(originalPath), { recursive: true });
          await fs.promises.writeFile(originalPath, content);
          return true;
        } catch (err) {
          this.logger.debug(`Skipped locked/inaccessible file during restore: ${relativePath} (${String(err)})`);
          skippedPaths.push(relativePath);
          return false;
        }
      });

      const results = await GitCheckpoint.runPool(restoreTasks, GitCheckpoint.IO_CONCURRENCY);
      const restored = results.filter(Boolean).length;

      this.logger.info('Restored from checkpoint', { ref, restored, skipped: skippedPaths.length });
      if (skippedPaths.length > 0) {
        this.logger.warn(`${skippedPaths.length} file(s) not restored: ${skippedPaths.join(', ')}`);
        vscode.window.showWarningMessage(
          `BurstCode: restored ${restored} file(s), but ${skippedPaths.length} could not be restored (locked or not captured in this checkpoint). See BurstCode output for details.`
        );
      }

      // Rollback discards forward history: delete every checkpoint newer than
      // the one we restored to. Chain-safe because a checkpoint's base is always
      // older, so nothing we keep depends on what we delete. No safety net is
      // retained — by design, a rollback cannot itself be undone.
      const targetTs = Number(timestamp);
      if (Number.isFinite(targetTs)) {
        const removed = await this.deleteForwardCheckpoints(wsRoot, targetTs);
        if (removed > 0) this.logger.info('Pruned forward checkpoints after rollback', { removed });
      }

      if (scope) {
        // Scoped rollback: only delete files the SESSION created — i.e. paths
        // the session wrote that did NOT exist at checkpoint time (absent from
        // the full snapshot). We must not walk the whole tree here: that would
        // delete files belonging to other sessions / the user.
        let deletedCreated = 0;
        for (const rel of scope) {
          if (fullSourceMap.has(rel) || fullSourceMap.has(rel.replace(/\//g, path.sep))) continue;
          const abs = path.join(wsRoot, rel);
          try {
            await fs.promises.unlink(abs);
            deletedCreated++;
          } catch {
            /* missing or locked — nothing to clean up */
          }
        }
        if (deletedCreated > 0) {
          this.logger.info('Deleted session-created files after scoped restore', { count: deletedCreated });
        }
      } else {
        // Legacy whole-tree rollback (quick-pick command): delete files that
        // exist on disk but are NOT in the resolved snapshot. These are files
        // created AFTER the checkpoint that the snapshot doesn't know about —
        // without this step they'd survive the rollback as orphans. We skip the
        // checkpoint directory itself and common build artifacts.
        const snapshotPaths = new Set(sourceMap.keys());
        const ignoreRules = await this.readGitignoreRules(wsRoot);
        const postRestoreDeleted = await this.deleteOrphanFiles(wsRoot, wsRoot, snapshotPaths, new Set(), ignoreRules);
        if (postRestoreDeleted > 0) {
          this.logger.info('Deleted orphan files after restore', { count: postRestoreDeleted });
        }
      }

      return true;
    } catch (err) {
      this.logger.error('Restore failed', String(err));
      vscode.window.showErrorMessage(`BurstCode: failed to restore checkpoint: ${String(err)}`);
      return false;
    } finally {
      // Always invalidate the chain cache after a restore attempt (success OR
      // failure): disk state may have changed and forward checkpoints may have
      // been pruned, so any cached sourceMap (and its blob paths) is now stale.
      this._resolvedSourceMapCache = null;
      this._resolvedSourceMapRef = '';
    }
  }

  /**
   * Resolve a file-based checkpoint into the full set of files it represents by
   * overlaying its delta on top of its base chain. Returns a map of
   * workspace-relative path → absolute path of the stored blob to read from.
   * Entries closer to the target override those from older bases.
   *
   * Degrades gracefully: a missing/corrupt manifest truncates the chain (with a
   * warning) rather than failing the whole restore. `visited` guards against
   * cycles in a malformed chain.
   */
  private async resolveCheckpointChain(
    wsRoot: string,
    ref: string,
    visited: Set<string>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) return result;

    // Return cached result when this is a top-level call on the same ref.
    if (visited.size === 0 && ref === this._resolvedSourceMapRef && this._resolvedSourceMapCache) {
      return new Map(this._resolvedSourceMapCache);
    }

    const timestamp = ref.slice(GitCheckpoint.FILE_REF_PREFIX.length);
    if (visited.has(timestamp)) {
      this.logger.warn(`Checkpoint chain cycle detected at ${ref}; stopping.`);
      return result;
    }
    visited.add(timestamp);

    const checkpointDir = path.join(this.getCheckpointDir(wsRoot), timestamp);
    let manifest: { baseRef?: string; files?: Array<{ relativePath: string }>; deleted?: string[] };
    try {
      manifest = JSON.parse(await fs.promises.readFile(path.join(checkpointDir, 'manifest.json'), 'utf-8'));
    } catch (err) {
      this.logger.warn(`Checkpoint ${ref} manifest unreadable; chain truncated. (${String(err)})`);
      return result;
    }

    // Base first, so this checkpoint's changes override the inherited ones.
    if (manifest.baseRef) {
      const baseMap = await this.resolveCheckpointChain(wsRoot, manifest.baseRef, visited);
      for (const [k, v] of baseMap) result.set(k, v);
    }

    // Drop files that were deleted from the working tree as of this checkpoint.
    for (const d of manifest.deleted ?? []) {
      result.delete(d);
    }

    for (const file of manifest.files ?? []) {
      const encoded = file.relativePath.replace(/[^a-zA-Z0-9._-]/g, '_');
      result.set(file.relativePath, path.join(checkpointDir, encoded));
    }

    // Cache the full result at the top-level call.
    if (visited.size === 1) {
      this._resolvedSourceMapRef = ref;
      this._resolvedSourceMapCache = new Map(result);
    }
    return result;
  }

  /**
   * Recursively delete files that exist on disk but are NOT in `knownPaths`.
   * Used after checkpoint restore to clean up files created after the checkpoint.
   * Skips the checkpoint directory itself and common build artifact dirs.
   * Returns the count of deleted files.
   */
  private async deleteOrphanFiles(
    currentDir: string,
    baseDir: string,
    knownPaths: Set<string>,
    visited: Set<string>,
    ignoreRules: GitignoreRule[]
  ): Promise<number> {
    const resolved = path.resolve(currentDir);
    if (visited.has(resolved)) return 0;
    visited.add(resolved);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    let deleted = 0;
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = GitCheckpoint.normalizeRelativePath(path.relative(baseDir, fullPath));
      if (GitCheckpoint.isIgnoredByGitignore(relativePath, ignoreRules)) continue;

      if (entry.isDirectory()) {
        // Skip hidden dirs, build artifacts, and the checkpoint store itself.
        if (entry.name.startsWith('.') || GitCheckpoint.SKIP_DIRS.has(entry.name)) continue;
        deleted += await this.deleteOrphanFiles(fullPath, baseDir, knownPaths, visited, ignoreRules);
        // After processing children, try to remove the directory if empty.
        try {
          const remaining = await fs.promises.readdir(fullPath);
          if (remaining.length === 0) {
            await fs.promises.rmdir(fullPath);
          }
        } catch {
          /* not empty or locked — leave it */
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (GitCheckpoint.BINARY_EXTENSIONS.has(ext)) continue;
        if (!knownPaths.has(relativePath)) {
          try {
            await fs.promises.unlink(fullPath);
            deleted++;
          } catch {
            /* locked — skip */
          }
        }
      }
    }
    return deleted;
  }

  private async restoreGitCheckpoint(ref: string): Promise<boolean> {
    const root = await this.tryRepoRoot();
    if (!root) {
      vscode.window.showErrorMessage('BurstCode: this checkpoint requires a git repository to restore.');
      return false;
    }
    try {
      await this.createCheckpoint('pre-restore safety snapshot');
    } catch (err) {
      this.logger.warn('Pre-restore safety checkpoint failed (continuing with restore)', String(err));
    }
    try {
      await this.run(root, ['checkout', ref, '--', '.']);
      this.logger.info('Restored from legacy git checkpoint', { ref });
      return true;
    } catch (err) {
      this.logger.error('Git restore failed', String(err));
      vscode.window.showErrorMessage(`BurstCode: failed to restore checkpoint: ${String(err)}`);
      return false;
    }
  }

  /** Show a quick-pick of all checkpoints and restore the chosen one. */
  async restoreInteractive(): Promise<void> {
    const list = await this.listCheckpoints();
    if (list.length === 0) {
      vscode.window.showInformationMessage('BurstCode: no checkpoints found.');
      return;
    }
    const items: Array<vscode.QuickPickItem & { ref: string }> = list.map((c) => ({
      ref: c.ref,
      label: `$(history) ${new Date(c.createdAt).toLocaleString()}`,
      description: c.sha ? c.sha.slice(0, 8) : '',
      detail: c.label
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'BurstCode: Restore Checkpoint',
      placeHolder: 'Pick a snapshot to restore into the working tree'
    });
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Restore working tree from "${picked.detail}"? Current working tree will first be saved as a safety checkpoint.`,
      { modal: true },
      'Restore'
    );
    if (confirm !== 'Restore') return;
    const ok = await this.restoreCheckpoint(picked.ref);
    if (ok) {
      vscode.window.showInformationMessage('BurstCode: checkpoint restored.');
    }
  }

  private run(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        'git',
        args,
        { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr && stderr.toString()) || err.message));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });
  }
}
