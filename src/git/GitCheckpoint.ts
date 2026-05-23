import * as cp from 'child_process';
import * as vscode from 'vscode';
import { Logger } from '../util/Logger';

export interface CheckpointInfo {
  ref: string;
  sha: string;
  label: string;
  /** ms since epoch */
  createdAt: number;
}

/**
 * Creates lightweight rollback points by snapshotting the working tree into
 * `refs/burstcode/checkpoints/<timestamp>` using `git stash create` + `git update-ref`.
 *
 * The user's HEAD, index and working tree are NOT modified by `createCheckpoint`.
 * `restoreCheckpoint` replays the snapshot's tree onto the working tree (no commit).
 */
export class GitCheckpoint {
  private static readonly REF_PREFIX = 'refs/burstcode/checkpoints/';
  /**
   * Cached git toplevel path. ONLY POSITIVE results are cached — a previous
   * detection failure (transient `git rev-parse` slowness, AV lock on `.git/`,
   * workspace folders not yet ready, ...) must NEVER turn into a permanent
   * "no checkpoints" state for the rest of the extension's lifetime. Caching
   * `null` like the previous implementation did is what made the rollback
   * button silently say "no checkpoint" forever after the first hiccup.
   */
  private repoRootCache: string | undefined;

  constructor(private readonly logger: Logger) {}

  isEnabled(): boolean {
    return (
      vscode.workspace.getConfiguration('burstcode.git').get<boolean>('autoCheckpoint') ?? true
    );
  }

  private async repoRoot(): Promise<string | undefined> {
    if (this.repoRootCache) return this.repoRootCache;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return undefined;
    try {
      const out = (await this.run(ws, ['rev-parse', '--show-toplevel'])).trim();
      if (out) {
        this.repoRootCache = out;
        return out;
      }
      return undefined;
    } catch {
      // DON'T cache the failure — let the next call retry. `git rev-parse`
      // can flake transiently (extension activation race, AV scan, slow disk)
      // and a single miss must not poison every future checkpoint attempt.
      return undefined;
    }
  }

  /** Force re-detection on next call (e.g. after a workspace folder change). */
  invalidate(): void {
    this.repoRootCache = undefined;
  }

  /**
   * Snapshot the working tree into `refs/burstcode/checkpoints/<ts>` and return
   * the new checkpoint info. THROWS with a descriptive message on every
   * failure path so callers (and the user, via the chat banner / rollback
   * button tooltip) see exactly WHY checkpointing did not happen. Earlier
   * versions silently returned `undefined`, which is what made "始终没有
   * checkpoint" un-diagnosable: the user had no way to tell apart
   * "setting off", "not a git repo", "empty repo", or "git command failed".
   *
   * Callers should `try { … } catch (err) { … }` and surface `err.message`.
   */
  async createCheckpoint(label: string): Promise<CheckpointInfo> {
    if (!this.isEnabled()) {
      const msg = 'burstcode.git.autoCheckpoint is disabled';
      this.logger.warn(`Git checkpoint skipped: ${msg} — rollback button will be unavailable.`);
      throw new Error(msg);
    }
    const root = await this.repoRoot();
    if (!root) {
      const msg = 'workspace is not a git repository';
      this.logger.warn(`Git checkpoint skipped: ${msg} (git rev-parse --show-toplevel failed).`);
      throw new Error(msg);
    }

    const message = `BurstCode checkpoint: ${label}`.replace(/\r?\n/g, ' ').slice(0, 200);
    let sha = '';
    let stashErr: string | undefined;
    try {
      // `-u` so the snapshot also covers UNTRACKED files (brand-new files
      // created by `propose_edit` / `write_file`). Without `-u`, rollback
      // would leave any agent-created files behind on disk.
      sha = (await this.run(root, ['stash', 'create', '-u', message])).trim();
    } catch (err) {
      // `stash create` can fail on a fresh repo with no commits; we'll fall
      // back to HEAD below, but keep the error for the final throw.
      stashErr = err instanceof Error ? err.message : String(err);
      this.logger.debug('git stash create -u failed', stashErr);
    }
    if (!sha) {
      // Working tree is clean (and no untracked files) — snapshot HEAD instead.
      try {
        sha = (await this.run(root, ['rev-parse', 'HEAD'])).trim();
      } catch (err) {
        const headErr = err instanceof Error ? err.message : String(err);
        const msg = `empty repository or no HEAD commit (${headErr})`;
        this.logger.warn(`Git checkpoint skipped: ${msg}`);
        throw new Error(msg);
      }
    }
    if (!sha) {
      const msg = stashErr
        ? `could not resolve a snapshot SHA (stash create: ${stashErr})`
        : 'could not resolve a snapshot SHA';
      this.logger.warn(`Git checkpoint skipped: ${msg}`);
      throw new Error(msg);
    }

    const createdAt = Date.now();
    const ref = `${GitCheckpoint.REF_PREFIX}${createdAt}`;
    try {
      await this.run(root, ['update-ref', '-m', message, ref, sha]);
    } catch (err) {
      const msg = `git update-ref failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logger.warn(`Git checkpoint failed: ${msg}`);
      throw new Error(msg);
    }
    this.logger.info('Git checkpoint created', { ref, sha: sha.slice(0, 12), label });
    return { ref, sha, label, createdAt };
  }

  /** True iff a ref under `refs/burstcode/checkpoints/` still resolves. */
  async refExists(ref: string): Promise<boolean> {
    if (!ref || !ref.startsWith(GitCheckpoint.REF_PREFIX)) return false;
    const root = await this.repoRoot();
    if (!root) return false;
    try {
      const out = (await this.run(root, ['rev-parse', '--verify', '--quiet', ref])).trim();
      return out.length > 0;
    } catch {
      return false;
    }
  }

  async listCheckpoints(): Promise<CheckpointInfo[]> {
    const root = await this.repoRoot();
    if (!root) return [];
    try {
      const out = await this.run(root, [
        'for-each-ref',
        '--format=%(refname)%09%(objectname)%09%(subject)',
        '--sort=-refname',
        GitCheckpoint.REF_PREFIX
      ]);
      const lines = out.split(/\r?\n/).filter(Boolean);
      const infos: CheckpointInfo[] = [];
      for (const line of lines) {
        const [ref, sha, ...rest] = line.split('\t');
        if (!ref || !sha) continue;
        const subject = rest.join('\t');
        const tsStr = ref.slice(GitCheckpoint.REF_PREFIX.length);
        const createdAt = Number(tsStr);
        const label = subject.replace(/^BurstCode checkpoint:\s*/, '');
        infos.push({
          ref,
          sha,
          label,
          createdAt: Number.isFinite(createdAt) ? createdAt : 0
        });
      }
      return infos;
    } catch (err) {
      this.logger.warn('Failed to list git checkpoints', String(err));
      return [];
    }
  }

  /**
   * Restore the working tree to the checkpoint's snapshot.
   * Does NOT touch HEAD or the index history. Equivalent to `git checkout <ref> -- .`
   */
  async restoreCheckpoint(ref: string): Promise<boolean> {
    const root = await this.repoRoot();
    if (!root) {
      vscode.window.showErrorMessage('BurstCode: workspace is not a git repository.');
      return false;
    }
    // Save uncommitted state into another checkpoint first so the user doesn't
    // lose work. Failure here is non-fatal — proceed to the actual restore so
    // the user's explicit request still goes through (and they were warned via
    // logger.warn from inside createCheckpoint).
    try {
      await this.createCheckpoint('pre-restore safety snapshot');
    } catch (err) {
      this.logger.warn('Pre-restore safety checkpoint failed (continuing with restore)', String(err));
    }
    try {
      await this.run(root, ['checkout', ref, '--', '.']);
      this.logger.info('Restored from checkpoint', { ref });
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
      description: c.sha.slice(0, 8),
      detail: c.label
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'BurstCode: Restore Git Checkpoint',
      placeHolder: 'Pick a snapshot to restore into the working tree'
    });
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Restore working tree from "${picked.detail}"? Current uncommitted changes will be saved as a new safety checkpoint first.`,
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
