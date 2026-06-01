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
  let absPath: string;
  if (path.isAbsolute(target)) {
    absPath = target;
  } else {
    const root = workspaceRoot();
    if (!root) throw new Error('No workspace folder open.');
    absPath = path.join(root, target);
  }
  // On Windows, path.join produces backslash-separated paths. vscode.Uri.file()
  // is supposed to normalize them to forward slashes, but some VS Code builds
  // fail to do so when the path contains non-ASCII characters (e.g. Chinese),
  // resulting in %5C (encoded backslash) in the URI which then causes
  // openTextDocument / readDirectory to fail. Normalize explicitly here.
  if (process.platform === 'win32') {
    absPath = absPath.replace(/\\/g, '/');
  }
  return vscode.Uri.file(absPath);
}

export function buildReadFileTool(applier?: HunkApplier): Tool {
  return {
    name: 'read_file',
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a slice of a workspace file with 1-indexed line numbers. ' +
          'Use for a SINGLE targeted follow-up read when you already know the exact file and line range. ' +
          'To read 2+ files or combine a read with a grep, use collect_context instead — it runs everything concurrently in one round-trip.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to workspace or absolute.' },
            startLine: { type: 'number', description: '1-indexed start line (inclusive). Defaults to 1.' },
            endLine: { type: 'number', description: '1-indexed end line (inclusive). Defaults to startLine+200.' },
            full: { type: 'boolean', description: 'When true, read the ENTIRE file from startLine to the last line, ignoring the default 200-line window. Use sparingly — large files flood the shared context window. Default false.' }
          },
          required: ['path']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (args.path === undefined || args.path === null || String(args.path).trim() === '' || String(args.path) === 'undefined') {
        return {
          content: 'Error: read_file requires a valid non-empty "path" argument.',
          isError: true
        };
      }
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
        pendingNote = ' [pending edits on disk — compile/run/test can proceed NOW without accepting; Accept confirms, Reject reverts]';
      } else {
        const doc = await vscode.workspace.openTextDocument(uri);
        rawLines = [];
        for (let i = 0; i < doc.lineCount; i++) rawLines.push(doc.lineAt(i).text);
      }
      const total = rawLines.length;
      const start = Math.max(1, Number(args.startLine) || 1);
      const full = args.full === true || args.full === 'true';
      const end = full
        ? total
        : Math.min(total, Number(args.endLine) || Math.min(total, start + 199));
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
        'Return a tree-shaped overview of the workspace (or a sub-path). ' +
        'Use for a SINGLE outline when you need to drill into one specific path. ' +
        'To combine an outline with reads or greps, use collect_context instead.',
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
      description:
        'List files and directories under a path (workspace-relative or absolute). ' +
        'For a single directory listing on its own. To combine with reads or greps, use collect_context.',
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
        'Search for a regex or literal text across the workspace using ripgrep. Returns matches with file:line. ' +
        'Use for a SINGLE targeted search. To run multiple searches or combine with file reads, use collect_context instead.',
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
    if (args.query === undefined || args.query === null || String(args.query).trim() === '' || String(args.query) === 'undefined') {
      return {
        content: 'Error: grep_search requires a valid non-empty "query" argument.',
        isError: true
      };
    }
    const query = String(args.query);
    const fixed = !!args.fixedStrings;
    const glob = args.glob ? String(args.glob) : undefined;
    const max = Math.min(Number(args.maxResults) || 200, 1000);

    const rgPath = await findRipgrep();
    if (!rgPath) {
      return {
        content: ripgrepMissingMessage(),
        isError: true
      };
    }
    return new Promise<ToolResult>((resolve, reject) => {
      const cliArgs = ['--vimgrep', '--no-heading', '--color', 'never', '--max-count', '50'];
      if (fixed) cliArgs.push('-F');

      // Determine search target: if glob has no wildcards it is a concrete file
      // or directory path — resolve it and pass directly as the search path so
      // ripgrep doesn't try to match it as a glob pattern (which fails for
      // paths like "src/agent/prompts.ts" when the cwd != root).
      // Otherwise use -g for wildcard glob filtering over the whole root.
      const isLiteralPath = glob && !/[*?\[{]/.test(glob);
      const searchTarget = isLiteralPath
        ? resolveUri(glob!).fsPath   // absolute path → works regardless of cwd
        : root;
      if (glob && !isLiteralPath) cliArgs.push('-g', glob);
      cliArgs.push('--', query, searchTarget);
      const proc = cp.spawn(rgPath, cliArgs, { cwd: root });
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
        // A missing/un-spawnable ripgrep surfaces here as ENOENT. Don't let the
        // raw error bubble up as an opaque "spawn rg.exe ENOENT" — invalidate
        // the cached path (so a later install is re-detected) and return the
        // same actionable guidance the pre-spawn check uses.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          cachedRgPath = undefined;
          resolve({ content: ripgrepMissingMessage(), isError: true });
          return;
        }
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

// ---------------------------------------------------------------------------
// collect_context — gather multiple reads / greps / lists / outlines in ONE
// tool call. All sub-operations run concurrently; results are returned as a
// single labelled bundle. This eliminates the N sequential LLM round-trips
// that occur when a model issues read_file / grep_search one at a time.
// ---------------------------------------------------------------------------

/** Maximum number of each kind of sub-operation per call (DOS guard). */
const CC_MAX_READS = 16;
const CC_MAX_GREPS = 16;
const CC_MAX_LISTS = 8;
const CC_MAX_OUTLINES = 8;

export function buildCollectContextTool(applier?: HunkApplier): Tool {
  const readFileTool = buildReadFileTool(applier);

  return {
    name: 'collect_context',
    parallelSafe: true,
    noTimeout: true,
    schema: {
      type: 'function',
      function: {
        name: 'collect_context',
        description:
          'Collect multiple kinds of workspace context in ONE round-trip. ' +
          'Pass any combination of files to read, patterns to grep, directories to list, ' +
          'and paths to outline — all sub-operations execute concurrently. ' +
          'Use this as the FIRST move on any non-trivial question instead of issuing ' +
          'read_file / grep_search one at a time across multiple turns. ' +
          'IMPORTANT: You MUST provide at least one entry across files / searches / dirs / trees. Empty calls will fail — if you have nothing to collect, do not call this tool. ' +
          'Each of files / searches / dirs / trees MUST be a JSON array, even when you only have a single entry (wrap that one object in an array).',
        parameters: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              description: `Up to ${CC_MAX_READS} file regions to read. Same args as read_file. MUST be a JSON array, even for a single entry.`,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Workspace-relative or absolute path.' },
                  startLine: { type: 'number', description: '1-indexed start line (inclusive). Defaults to 1.' },
                  endLine: { type: 'number', description: '1-indexed end line (inclusive). Defaults to startLine+200.' }
                },
                required: ['path']
              }
            },
            searches: {
              type: 'array',
              description: `Up to ${CC_MAX_GREPS} ripgrep searches. Same args as grep_search. MUST be a JSON array, even for a single entry.`,
              items: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Regex pattern (or literal when fixedStrings=true).' },
                  fixedStrings: { type: 'boolean' },
                  glob: { type: 'string', description: 'Optional glob filter, e.g. **/*.ts' },
                  maxResults: { type: 'number' }
                },
                required: ['query']
              }
            },
            dirs: {
              type: 'array',
              description: `Up to ${CC_MAX_LISTS} directory listings. Same args as list_dir. MUST be a JSON array, even for a single entry.`,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Defaults to workspace root.' }
                }
              }
            },
            trees: {
              type: 'array',
              description: `Up to ${CC_MAX_OUTLINES} workspace outlines. Same args as workspace_outline. MUST be a JSON array, even for a single entry.`,
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  depth: { type: 'number' },
                  maxBytes: { type: 'number' }
                }
              }
            }
          }
        }
      }
    },

    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      type TaskSpec = { label: string; promise: Promise<ToolResult> };
      const tasks: TaskSpec[] = [];

      const reads = Array.isArray(args.files) ? (args.files as Record<string, unknown>[]).slice(0, CC_MAX_READS) : [];
      const greps = Array.isArray(args.searches) ? (args.searches as Record<string, unknown>[]).slice(0, CC_MAX_GREPS) : [];
      const lists = Array.isArray(args.dirs) ? (args.dirs as Record<string, unknown>[]).slice(0, CC_MAX_LISTS) : [];
      const outlines = Array.isArray(args.trees) ? (args.trees as Record<string, unknown>[]).slice(0, CC_MAX_OUTLINES) : [];

      for (const r of reads) {
        const label = `read_file ${String(r.path)}${r.startLine != null ? `:${r.startLine}` : ''}${r.endLine != null ? `-${r.endLine}` : ''}`;
        tasks.push({ label, promise: readFileTool.execute(r, ctx) });
      }
      for (const g of greps) {
        const label = `grep_search ${String(g.query)}${g.glob ? ` [${g.glob}]` : ''}`;
        tasks.push({ label, promise: grepSearchTool.execute(g, ctx) });
      }
      for (const l of lists) {
        const label = `list_dir ${String(l.path ?? '.')}`;
        tasks.push({ label, promise: listDirTool.execute(l, ctx) });
      }
      for (const o of outlines) {
        const label = `workspace_outline ${String(o.path ?? '.')}`;
        tasks.push({ label, promise: workspaceOutlineTool.execute(o, ctx) });
      }

      if (tasks.length === 0) {
        return {
          content: 'collect_context: nothing to collect — you called collect_context with empty files/searches/dirs/trees parameters. These are PARAMETERS of collect_context, NOT separate tools. Retry with at least one entry, e.g. collect_context({"searches": [{"query": "your search", "glob": "**/*.cs"}]}) or collect_context({"files": [{"path": "src/file.ts"}]}). If you genuinely have nothing to collect, stop calling this tool.',
          isError: true
        };
      }

      ctx.emitProgress(`Collecting ${tasks.length} context source(s) concurrently…`);

      const settled = await Promise.allSettled(tasks.map((t) => t.promise));

      const sections: string[] = [];
      let errorCount = 0;
      settled.forEach((s, i) => {
        const label = tasks[i].label;
        if (s.status === 'fulfilled') {
          if (s.value.isError) errorCount++;
          const tag = s.value.isError ? ' [error]' : '';
          sections.push(`===== ${label}${tag} =====\n${s.value.content}`);
        } else {
          errorCount++;
          sections.push(`===== ${label} [failed] =====\n${String(s.reason)}`);
        }
      });

      const header = `# collect_context: ${tasks.length} source(s), ${errorCount} error(s)`;
      return {
        content: `${header}\n\n${sections.join('\n\n')}`,
        meta: { tasks: tasks.length, errors: errorCount },
        isError: errorCount === tasks.length
      };
    }
  };
}

/**
 * Cached ripgrep resolution. `undefined` = not yet resolved OR last resolution
 * found nothing (we re-probe in that case so a freshly-installed rg is picked
 * up). A non-empty string is a confirmed, on-disk (or PATH-resolved) binary.
 */
let cachedRgPath: string | undefined;

function ripgrepMissingMessage(): string {
  return (
    'grep_search unavailable: could not locate a ripgrep (rg) binary. ' +
    'BurstCode searches the VS Code install (appRoot) and your system PATH for ripgrep. ' +
    'Fix by either (a) installing ripgrep and adding it to your PATH ' +
    '(https://github.com/BurntSushi/ripgrep#installation), or ' +
    '(b) setting "burstcode.ripgrepPath" to the full path of rg(.exe), then reloading the window. ' +
    'In the meantime use read_file / collect_context (reads) / list_dir, which do not require ripgrep.'
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve `rg` from the system PATH (returns the bare exe name if found). */
async function findRipgrepOnPath(exe: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      const child = cp.spawn(probe, [exe]);
      let out = '';
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('error', () => resolve(undefined));
      child.on('close', (code) => {
        const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        resolve(code === 0 && first ? first : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Shallow recursive scan for an rg binary under `dir` (depth-limited). */
async function scanForRipgrep(dir: string, exe: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries: import('fs').Dirent[];
  try {
    const fs = await import('fs/promises');
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // Check files at this level first.
  for (const e of entries) {
    if (e.isFile() && e.name === exe) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await scanForRipgrep(path.join(dir, e.name), exe, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Locate a usable ripgrep binary. Strategy (first hit wins, result cached):
 *   1. Explicit `burstcode.ripgrepPath` setting.
 *   2. Known VS Code bundled locations under appRoot.
 *   3. A depth-limited recursive scan of appRoot (covers builds/forks that
 *      put rg in a non-standard subfolder — e.g. VSCodium, Cursor, portable).
 *   4. The system PATH (`where`/`which`).
 * Returns `undefined` when nothing is found so callers can show actionable
 * guidance instead of letting `cp.spawn` throw an opaque ENOENT.
 */
async function findRipgrep(): Promise<string | undefined> {
  if (cachedRgPath && (await pathExists(cachedRgPath))) return cachedRgPath;
  cachedRgPath = undefined;

  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';

  // 1. User override.
  const override = vscode.workspace
    .getConfiguration('burstcode')
    .get<string>('ripgrepPath');
  if (override && override.trim() && (await pathExists(override.trim()))) {
    return (cachedRgPath = override.trim());
  }

  const appRoot = vscode.env.appRoot;

  // 2. Known bundled locations.
  const candidates = [
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules.asar.unpacked', 'vscode-ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(appRoot, 'node_modules', 'vscode-ripgrep', 'bin', exe)
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return (cachedRgPath = c);
  }

  // 3. Depth-limited recursive scan of appRoot (build/fork-specific layouts).
  const scanned = await scanForRipgrep(appRoot, exe, 5);
  if (scanned) return (cachedRgPath = scanned);

  // 4. System PATH.
  const onPath = await findRipgrepOnPath(exe);
  if (onPath) return (cachedRgPath = onPath);

  return undefined;
}
