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
 * `refs/quickcode/checkpoints/<timestamp>` using `git stash create` + `git update-ref`.
 *
 * The user's HEAD, index and working tree are NOT modified by `createCheckpoint`.
 * `restoreCheckpoint` replays the snapshot's tree onto the working tree (no commit).
 */
export class GitCheckpoint {
  private static readonly REF_PREFIX = 'refs/quickcode/checkpoints/';
  private repoRootCache: string | null | undefined;

  constructor(private readonly logger: Logger) {}

  isEnabled(): boolean {
    return (
      vscode.workspace.getConfiguration('quickcode.git').get<boolean>('autoCheckpoint') ?? true
    );
  }

  private async repoRoot(): Promise<string | undefined> {
    if (this.repoRootCache !== undefined) {
      return this.repoRootCache ?? undefined;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) {
      this.repoRootCache = null;
      return undefined;
    }
    try {
      const out = (await this.run(ws, ['rev-parse', '--show-toplevel'])).trim();
      this.repoRootCache = out || null;
      return out || undefined;
    } catch {
      this.repoRootCache = null;
      return undefined;
    }
  }

  /** Force re-detection on next call (e.g. after a workspace folder change). */
  invalidate(): void {
    this.repoRootCache = undefined;
  }

  /**
   * Snapshot the working tree into `refs/quickcode/checkpoints/<ts>`.
   * Returns the new checkpoint info, or undefined if disabled / not a git repo / git failure.
   */
  async createCheckpoint(label: string): Promise<CheckpointInfo | undefined> {
    if (!this.isEnabled()) return undefined;
    const root = await this.repoRoot();
    if (!root) return undefined;

    try {
      const message = `QuickCode checkpoint: ${label}`.replace(/\r?\n/g, ' ').slice(0, 200);
      let sha = '';
      try {
        sha = (await this.run(root, ['stash', 'create', message])).trim();
      } catch (err) {
        // `stash create` fails on a fresh repo with no commits; fall through to HEAD lookup.
        this.logger.debug('git stash create failed', String(err));
      }
      if (!sha) {
        try {
          sha = (await this.run(root, ['rev-parse', 'HEAD'])).trim();
        } catch {
          // No HEAD yet (empty repo). Nothing to snapshot.
          return undefined;
        }
      }
      if (!sha) return undefined;

      const createdAt = Date.now();
      const ref = `${GitCheckpoint.REF_PREFIX}${createdAt}`;
      await this.run(root, ['update-ref', '-m', message, ref, sha]);
      this.logger.info('Git checkpoint created', { ref, sha: sha.slice(0, 12), label });
      return { ref, sha, label, createdAt };
    } catch (err) {
      this.logger.warn('Failed to create git checkpoint', String(err));
      return undefined;
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
        const label = subject.replace(/^QuickCode checkpoint:\s*/, '');
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
      vscode.window.showErrorMessage('QuickCode: workspace is not a git repository.');
      return false;
    }
    try {
      // Save uncommitted state into another checkpoint first so the user doesn't lose work.
      await this.createCheckpoint('pre-restore safety snapshot');
      await this.run(root, ['checkout', ref, '--', '.']);
      this.logger.info('Restored from checkpoint', { ref });
      return true;
    } catch (err) {
      this.logger.error('Git restore failed', String(err));
      vscode.window.showErrorMessage(`QuickCode: failed to restore checkpoint: ${String(err)}`);
      return false;
    }
  }

  /** Show a quick-pick of all checkpoints and restore the chosen one. */
  async restoreInteractive(): Promise<void> {
    const list = await this.listCheckpoints();
    if (list.length === 0) {
      vscode.window.showInformationMessage('QuickCode: no checkpoints found.');
      return;
    }
    const items: Array<vscode.QuickPickItem & { ref: string }> = list.map((c) => ({
      ref: c.ref,
      label: `$(history) ${new Date(c.createdAt).toLocaleString()}`,
      description: c.sha.slice(0, 8),
      detail: c.label
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'QuickCode: Restore Git Checkpoint',
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
      vscode.window.showInformationMessage('QuickCode: checkpoint restored.');
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
