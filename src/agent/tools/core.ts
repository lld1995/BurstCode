import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { Tool, ToolContext, ToolResult } from './types';
import { HunkApplier } from '../../edits/HunkApplier';
import { buildWorkspaceOutline } from '../../context/WorkspaceOutline';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveUri(target: string): vscode.Uri {
  if (target.startsWith('file:')) return vscode.Uri.parse(target);
  if (path.isAbsolute(target)) return vscode.Uri.file(target);
  const root = workspaceRoot();
  if (!root) throw new Error('No workspace folder open.');
  return vscode.Uri.file(path.join(root, target));
}

export function buildReadFileTool(applier?: HunkApplier): Tool {
  return {
    name: 'read_file',
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a slice of a workspace file with 1-indexed line numbers. Use this to inspect code regions; prefer reading targeted ranges over whole files.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to workspace or absolute.' },
            startLine: { type: 'number', description: '1-indexed start line (inclusive). Defaults to 1.' },
            endLine: { type: 'number', description: '1-indexed end line (inclusive). Defaults to startLine+200.' }
          },
          required: ['path']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.path);
      const uri = resolveUri(target);
      let text: string;
      let total: number;
      let pendingNote = '';
      const pendingContent = applier?.getPendingModifiedContent(uri);
      if (pendingContent !== undefined) {
        text = pendingContent;
        total = text.split(/\r?\n/).length;
        pendingNote = ' [pending edits applied — not yet written to disk]';
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        text = doc.getText();
        total = doc.lineCount;
      }
      const start = Math.max(1, Number(args.startLine) || 1);
      const end = Math.min(total, Number(args.endLine) || Math.min(total, start + 199));
      const rawLines = text.split(/\r?\n/);
      const lines: string[] = [];
      for (let i = start - 1; i < end; i++) {
        lines.push(`${(i + 1).toString().padStart(5)}\t${rawLines[i] ?? ''}`);
      }
      return {
        content: `# ${vscode.workspace.asRelativePath(uri)} (lines ${start}-${end} of ${total})${pendingNote}\n${lines.join('\n')}`,
        meta: { uri: uri.toString(), totalLines: total, start, end, hasPendingEdits: pendingContent !== undefined }
      };
    }
  };
}

export const readFileTool: Tool = buildReadFileTool();

export const workspaceOutlineTool: Tool = {
  name: 'workspace_outline',
  schema: {
    type: 'function',
    function: {
      name: 'workspace_outline',
      description:
        'Return a tree-shaped overview of the workspace (or a sub-path) to help locate files before reading them. Useful when the system prompt outline was truncated or you need to drill deeper into a specific folder. Respects .gitignore and skips common build/junk dirs (node_modules, dist, out, .git, ...).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional sub-path (workspace-relative or absolute). Defaults to the workspace root.'
          },
          depth: {
            type: 'number',
            description:
              'How many directory levels to expand (default 3). Larger values cost more tokens.'
          },
          maxBytes: {
            type: 'number',
            description: 'Soft cap on output size in characters (default 4000).'
          }
        }
      }
    }
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const target = args.path ? String(args.path) : '.';
    const uri = resolveUri(target);
    const depth = Math.max(1, Math.min(Number(args.depth) || 3, 6));
    const maxBytes = Math.max(500, Math.min(Number(args.maxBytes) || 4000, 16000));
    const result = await buildWorkspaceOutline(uri.fsPath, {
      baseDepth: depth,
      srcDepth: depth + 1,
      maxBytes
    });
    const rel = vscode.workspace.asRelativePath(uri);
    const truncatedNote = result.truncated
      ? '\n(output truncated; call again with a deeper path if you need more detail)'
      : '';
    return {
      content: `# workspace_outline ${rel} (depth=${depth}, dirs=${result.dirsVisited})\n${result.text}${truncatedNote}`,
      meta: {
        path: uri.toString(),
        depth,
        truncated: result.truncated,
        dirsVisited: result.dirsVisited
      }
    };
  }
};

export const listDirTool: Tool = {
  name: 'list_dir',
  schema: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories under a path (workspace-relative or absolute).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Defaults to workspace root.' }
        }
      }
    }
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const target = args.path ? String(args.path) : '.';
    const uri = resolveUri(target);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries
      .map(([name, type]) => `${type === vscode.FileType.Directory ? 'D' : 'F'}  ${name}`)
      .sort();
    return {
      content: `# ${vscode.workspace.asRelativePath(uri)}\n${lines.join('\n') || '(empty)'}`,
      meta: { uri: uri.toString(), count: entries.length }
    };
  }
};

// Hard upper bound for a single grep_search invocation. Far above the 30s
// batch-safety net (which we opt out of via noTimeout) so legitimately slow
// searches on large repos can finish, but still finite so a wedged ripgrep
// process can't silently hang the agent forever.
const GREP_INTERNAL_TIMEOUT_MS = 10 * 60_000;

export const grepSearchTool: Tool = {
  name: 'grep_search',
  // grep can take longer than the AgentLoop's 30s batch-safety timeout on
  // large repos / broad regexes — opt out of that net. We keep ctx.cancellation
  // (so the user's stop button still works) and an internal 10-minute kill
  // timer below as the final safety.
  noTimeout: true,
  schema: {
    type: 'function',
    function: {
      name: 'grep_search',
      description:
        'Search for a regex or literal text across the workspace using ripgrep. Returns matches with file:line.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Regex pattern (or literal when fixedStrings=true).' },
          fixedStrings: { type: 'boolean' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. **/*.cs' },
          maxResults: { type: 'number' }
        },
        required: ['query']
      }
    }
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const root = workspaceRoot();
    if (!root) throw new Error('No workspace folder open.');
    const query = String(args.query);
    const fixed = !!args.fixedStrings;
    const glob = args.glob ? String(args.glob) : undefined;
    const max = Math.min(Number(args.maxResults) || 200, 1000);

    const rgPath = await findRipgrep();
    return new Promise<ToolResult>((resolve, reject) => {
      const cliArgs = ['--vimgrep', '--no-heading', '--color', 'never', '--max-count', '50'];
      if (fixed) cliArgs.push('-F');
      if (glob) cliArgs.push('-g', glob);
      cliArgs.push('--', query, root);
      const proc = cp.spawn(rgPath, cliArgs);
      let stdout = '';
      let stderr = '';
      let killedByInternalTimeout = false;
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      const cancelSub = ctx.cancellation.onCancellationRequested(() => proc.kill());
      const internalTimer = setTimeout(() => {
        killedByInternalTimeout = true;
        proc.kill();
      }, GREP_INTERNAL_TIMEOUT_MS);
      proc.on('error', (err) => {
        clearTimeout(internalTimer);
        cancelSub.dispose();
        reject(err);
      });
      proc.on('close', () => {
        clearTimeout(internalTimer);
        cancelSub.dispose();
        if (killedByInternalTimeout) {
          resolve({
            content: `# grep_search aborted after ${Math.round(GREP_INTERNAL_TIMEOUT_MS / 1000)}s — narrow the query / add a glob and retry`,
            isError: true
          });
          return;
        }
        const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
        resolve({
          content: lines.length
            ? `# matches (${lines.length})\n${lines.join('\n')}`
            : `# no matches${stderr ? '\n' + stderr.slice(0, 500) : ''}`,
          meta: { count: lines.length }
        });
      });
    });
  }
};

async function findRipgrep(): Promise<string> {
  // VS Code ships ripgrep at <appRoot>/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg(.exe)
  const appRoot = vscode.env.appRoot;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules', 'vscode-ripgrep', 'bin', exe)
  ];
  const fs = await import('fs/promises');
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return exe; // fall back to PATH
}
