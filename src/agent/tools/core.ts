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
      let rawLines: string[];
      let pendingNote = '';
      const pendingContent = applier?.getPendingModifiedContent(uri);
      if (pendingContent !== undefined) {
        rawLines = pendingContent.split(/\r?\n/);
        // Mirror VS Code's `doc.lineCount` semantics: a trailing newline does
        // not add a phantom empty line. Without this, line counts drift by 1
        // between the disk path and the pending path on every read.
        if (
          rawLines.length > 0 &&
          rawLines[rawLines.length - 1] === '' &&
          /\r?\n$/.test(pendingContent)
        ) {
          rawLines.pop();
        }
        pendingNote = ' [pending edits applied — not yet written to disk]';
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        rawLines = [];
        for (let i = 0; i < doc.lineCount; i++) rawLines.push(doc.lineAt(i).text);
      }
      const total = rawLines.length;
      const start = Math.max(1, Number(args.startLine) || 1);
      const end = Math.min(total, Number(args.endLine) || Math.min(total, start + 199));
      const lines: string[] = [];
      for (let i = start - 1; i < end; i++) {
        lines.push(`${(i + 1).toString().padStart(5)}\t${rawLines[i] ?? ''}`);
      }

      // When the file has pending edits, append an explicit map of each
      // hunk's range in modified-content coords. Without this, the model has
      // to guess where each pending hunk starts/ends in the post-edit view
      // — and a wrong guess silently corrupts subsequent propose_edits.
      let hunkMap = '';
      if (pendingContent !== undefined && applier) {
        const ranges = applier.getHunkRangesInModifiedCoords(uri);
        const visible = ranges.filter((r) => {
          // Show every hunk that intersects the visible window OR is non-empty.
          if (r.modStart > r.modEnd) return r.modStart >= start && r.modStart <= end;
          return r.modEnd >= start && r.modStart <= end;
        });
        if (visible.length > 0) {
          const lines2 = visible.map((r) => {
            // modStart > modEnd is the empty-range encoding emitted by
            // getHunkRangesInModifiedCoords for PURE DELETIONS (the hunk
            // removed lines from the original without inserting any lines
            // back, so it occupies zero lines in the modified view).
            // modStart points at the line just AFTER the deletion in
            // modified coords, i.e. the line that "took the place" of the
            // deleted block.
            const range = r.modStart > r.modEnd
              ? `(deletion before line ${r.modStart})`
              : r.modStart === r.modEnd
                ? `line ${r.modStart}`
                : `lines ${r.modStart}-${r.modEnd}`;
            return `#   - ${r.status.padEnd(8)} ${range}`;
          });
          hunkMap =
            `\n# pending hunks (modified-line coords) — use these ranges as-is when issuing follow-up propose_edit:\n` +
            lines2.join('\n');
        }
      }

      return {
        content: `# ${vscode.workspace.asRelativePath(uri)} (lines ${start}-${end} of ${total})${pendingNote}\n${lines.join('\n')}${hunkMap}`,
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

/**
 * Direct-write tool: writes content to disk immediately without queueing for
 * user review. Use for agent-generated scripts, temp files, and any file that
 * the agent will immediately read back or execute itself. For edits to
 * existing source files that belong to the user, prefer propose_edit so the
 * user can review and accept the diff.
 */
export function buildWriteFileTool(): Tool {
  return {
    name: 'write_file',
    parallelSafe: true,
    schema: {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write (or overwrite) a file on disk immediately — no user review step, no diff UI. Use for agent-generated helper scripts, temp/scratch files, config stubs, and any file the agent needs to create and then immediately execute or read back. NOT for modifying the user\'s existing source files — use propose_edit for those so the user can review the diff. Parent directories are created automatically. Path may be workspace-relative or absolute.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
            content: { type: 'string', description: 'Full file contents to write.' }
          },
          required: ['path', 'content']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.path ?? '').trim();
      if (!target) return { content: 'write_file: path is required', isError: true };
      const content = String(args.content ?? '');
      const uri = resolveUri(target);
      const fsModule = await import('fs/promises');
      const nodePath = await import('path');
      try {
        await fsModule.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        await fsModule.writeFile(uri.fsPath, content, 'utf8');
        const relPath = vscode.workspace.asRelativePath(uri);
        return {
          content: `Written ${content.split(/\r?\n/).length} line(s) to ${relPath}`,
          meta: { uri: uri.toString(), bytes: Buffer.byteLength(content, 'utf8') }
        };
      } catch (err) {
        return { content: `write_file failed: ${String((err as Error).message ?? err)}`, isError: true };
      }
    }
  };
}

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
