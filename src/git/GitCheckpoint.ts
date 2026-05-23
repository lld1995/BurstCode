import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../util/Logger';

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

  constructor(private readonly logger: Logger) {}

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
    baseDir: string
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
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !GitCheckpoint.SKIP_DIRS.has(entry.name)) {
          subdirPromises.push(this.gatherCandidates(fullPath, baseDir));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!GitCheckpoint.BINARY_EXTENSIONS.has(ext)) {
          fileCandidates.push({ fullPath, relativePath: path.relative(baseDir, fullPath) });
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

    try {
      // Phase 1: parallel directory walk — collect candidate paths
      const candidates = await this.gatherCandidates(wsRoot, wsRoot);

      // Phase 2: concurrent file reads
      const MAX = GitCheckpoint.MAX_FILE_SIZE;
      const readTasks = candidates.map(c => async () => {
        try {
          const stats = await fs.promises.stat(c.fullPath);
          if (stats.size > MAX) {
            this.logger.debug(`Skipping large file ${c.relativePath} (${stats.size} bytes)`);
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

      // Write manifest (tiny, no need to parallelize)
      const manifest = { label, createdAt, files: files.map(f => ({ relativePath: f.relativePath })) };
      await fs.promises.writeFile(path.join(checkpointDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Phase 3: concurrent checkpoint file writes
      const writeTasks = files.map(f => async () => {
        const encoded = f.relativePath.replace(/[^a-zA-Z0-9._-]/g, '_');
        await fs.promises.writeFile(path.join(checkpointDir, encoded), f.content);
      });
      await GitCheckpoint.runPool(writeTasks, GitCheckpoint.IO_CONCURRENCY);

      this.logger.info('Checkpoint created', { ref, label, fileCount: files.length });
      return { ref, sha: '', label, createdAt, isFileBased: true };
    } catch (err) {
      try { await fs.promises.rm(checkpointDir, { recursive: true, force: true }); } catch {}
      const msg = `checkpoint failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(msg);
      throw new Error(msg);
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

  async restoreCheckpoint(ref: string): Promise<boolean> {
    if (ref.startsWith(GitCheckpoint.FILE_REF_PREFIX)) {
      return this.restoreFileCheckpoint(ref);
    }
    if (ref.startsWith(GitCheckpoint.GIT_REF_PREFIX)) {
      return this.restoreGitCheckpoint(ref);
    }
    vscode.window.showErrorMessage('BurstCode: unknown checkpoint ref format.');
    return false;
  }

  private async restoreFileCheckpoint(ref: string): Promise<boolean> {
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
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));

      // Safety snapshot must complete before we start overwriting files.
      try {
        await this.createCheckpoint('pre-restore safety snapshot');
      } catch (err) {
        this.logger.warn('Pre-restore safety checkpoint failed (continuing with restore)', String(err));
      }

      // Concurrent restore
      const skippedPaths: string[] = [];
      let restored = 0;

      const restoreTasks = (manifest.files as Array<{ relativePath: string }>).map(file => async () => {
        const originalPath = path.join(wsRoot, file.relativePath);
        const encoded = file.relativePath.replace(/[^a-zA-Z0-9._-]/g, '_');
        const checkpointFilePath = path.join(checkpointDir, encoded);

        if (!fs.existsSync(checkpointFilePath)) {
          skippedPaths.push(file.relativePath);
          return false;
        }
        try {
          const content = await fs.promises.readFile(checkpointFilePath, 'utf-8');
          await fs.promises.mkdir(path.dirname(originalPath), { recursive: true });
          await fs.promises.writeFile(originalPath, content);
          return true;
        } catch (err) {
          this.logger.debug(`Skipped locked/inaccessible file during restore: ${file.relativePath} (${String(err)})`);
          skippedPaths.push(file.relativePath);
          return false;
        }
      });

      const results = await GitCheckpoint.runPool(restoreTasks, GitCheckpoint.IO_CONCURRENCY);
      restored = results.filter(Boolean).length;

      this.logger.info('Restored from checkpoint', { ref, restored, skipped: skippedPaths.length });
      if (skippedPaths.length > 0) {
        this.logger.warn(`${skippedPaths.length} file(s) not restored: ${skippedPaths.join(', ')}`);
        vscode.window.showWarningMessage(
          `BurstCode: restored ${restored} file(s), but ${skippedPaths.length} could not be restored (locked or not captured in this checkpoint). See BurstCode output for details.`
        );
      }
      return true;
    } catch (err) {
      this.logger.error('Restore failed', String(err));
      vscode.window.showErrorMessage(`BurstCode: failed to restore checkpoint: ${String(err)}`);
      return false;
    }
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
