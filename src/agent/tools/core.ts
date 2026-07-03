import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { Tool, ToolContext, ToolResult } from './types';
import { HunkApplier } from '../../edits/HunkApplier';
import { buildWorkspaceOutline } from '../../context/WorkspaceOutline';
import { repairJsonControlChars, repairJsonUnescapedQuotes } from '../../util/jsonRepair';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function truncateMiddleText(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n... [truncated ${omitted} chars; request a narrower range/search if needed] ...\n${text.slice(-tail)}`;
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

export function buildReadFileTool(applier?: HunkApplier, sessionId?: string): Tool {
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
            endLine: { type: 'number', description: '1-indexed end line (inclusive). Defaults to startLine+200; output is only this window, not proof that later lines are absent.' },
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

      // When the file has review-pending edits, append an explicit map of each
      // hunk's range in modified-content coords. The edits are already on disk;
      // this is only review/rollback metadata that keeps follow-up propose_edit
      // calls from guessing hunk boundaries and accidentally corrupting ranges.
      let hunkMap = '';
      if (pendingContent !== undefined && applier) {
        const ranges = applier.getHunkRangesInModifiedCoords(uri, sessionId);
        const visible = ranges.filter((r) => {
          // Show only hunks that intersect the visible window. A pure deletion
          // occupies zero modified lines, so include it when its anchor line is
          // inside the requested slice.
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
            `\n# review-pending hunk coordinates (already written to disk; Accept only confirms, Reject reverts):\n` +
            `# Use these modified-line ranges only if a follow-up propose_edit must touch the same hunk.\n` +
            lines2.join('\n');
        }
      }

      const readText = rawLines.join('\n');
      const readVersion = applier?.recordReadSnapshot(uri, readText);
      const readVersionNote = readVersion
        ? `\n# readVersion: ${readVersion} (pass as expectedReadVersion to replace_lines/delete_lines after this read so line drift can be detected and re-anchored)`
        : '';

      return {
        content: `# ${vscode.workspace.asRelativePath(uri)} (lines ${start}-${end} of ${total})${pendingNote}${readVersionNote}\n${lines.join('\n')}${hunkMap}`,
        meta: { uri: uri.toString(), totalLines: total, start, end, hasReviewPendingEdits: pendingContent !== undefined, readVersion }
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

function findLooseJsonStringEnd(text: string, start: number): number {
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch !== '"') continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const next = j < text.length ? text[j] : '';
    if (next === ',' || next === '}' || next === ']' || next === '') return i;
  }
  return -1;
}

function decodeLooseJsonString(raw: string): string {
  return raw
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function pickLooseStringField(
  text: string,
  keys: string[]
): { value: string; key: string; end: number } | undefined {
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index + m[0].length;
    const end = findLooseJsonStringEnd(text, start);
    if (end < 0) return undefined;
    return { key, value: decodeLooseJsonString(text.slice(start, end)), end };
  }
  return undefined;
}

function parsePartialJsonObject(raw: string): Record<string, unknown> | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    /* repair below */
  }
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) {
    if (esc) out += '\\';
    out += '"';
  }
  out = out.replace(/,\s*$/, '');
  if (stack[stack.length - 1] === '{') {
    out = out.replace(/(\{)\s*$/, '$1');
    out = out.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, '');
    out = out.replace(/(\{)\s*"(?:[^"\\]|\\.)*"\s*$/, '$1');
    out = out.replace(/:\s*$/, ': null');
    out = out.replace(/,\s*$/, '');
  }
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  try {
    const controlRepaired = repairJsonControlChars(out) ?? out;
    const quoteRepaired = repairJsonUnescapedQuotes(controlRepaired) ?? controlRepaired;
    const parsed = JSON.parse(quoteRepaired);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort recovery of a TRUNCATED write_file tool call. Unlike normal
 * JSON.parse, this intentionally accepts an unterminated trailing content string
 * and returns the bytes that already streamed so they can be written to disk; the
 * next model turn can read the partial file and append/repair only the missing tail.
 */
export function salvageWriteFileArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const partialParsed = parsePartialJsonObject(raw);
  const pathValue = partialParsed && typeof partialParsed.path === 'string'
    ? partialParsed.path
    : pickLooseStringField(raw, ['path', 'file', 'filePath', 'filename', 'fileName', 'target', 'targetFile', 'uri'])?.value;
  if (!pathValue || !String(pathValue).trim()) return null;
  let contentValue: string | undefined;
  if (partialParsed && typeof partialParsed.content === 'string') {
    contentValue = partialParsed.content;
  } else {
    const contentStart = /"content"\s*:\s*"/g.exec(raw);
    if (contentStart) {
      const start = contentStart.index + contentStart[0].length;
      const end = findLooseJsonStringEnd(raw, start);
      const rawContent = end >= 0 ? raw.slice(start, end) : raw.slice(start);
      contentValue = decodeLooseJsonString(rawContent);
    }
  }
  if (contentValue === undefined) return null;

  const modeValue = partialParsed && typeof partialParsed.mode === 'string'
    ? partialParsed.mode
    : pickLooseStringField(raw, ['mode'])?.value;
  const appendValue = partialParsed && typeof partialParsed.append === 'boolean'
    ? partialParsed.append
    : /"append"\s*:\s*true\b/.test(raw);
  const salvaged: Record<string, unknown> = { path: pathValue, content: contentValue, __bc_truncatedSalvage: true };
  if (modeValue === 'append' || appendValue) {
    salvaged.mode = 'append';
    salvaged.append = true;
  }
  return salvaged;
}

/**
 * Direct-write tool: writes content to disk immediately, then queues the
 * before/after whole-file snapshot in the normal pending review UI so Reject can
 * restore the previous file state (or delete a newly-created file).
 */

/**
 * Check if a file path is git-ignored by running `git check-ignore`.
 * Returns true if git says the path is ignored, false otherwise (including
 * when git is unavailable or the path is not in a git repo).
 */
function gitCheckIgnored(cwd: string, relPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile('git', ['check-ignore', '--quiet', relPath], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
    }, (err) => {
      // git check-ignore --quiet: exit 0 = ignored, non-zero = not ignored or error
      resolve(!err);
    });
  });
}

/**
 * Determine whether a write_file target should enter the pending review UI.
 * Uses `git check-ignore` to respect the project's .gitignore rules —
 * any path the project's .gitignore excludes is automatically skipped.
 * Always excludes .burstcode/ and .git/ (internal infrastructure) regardless.
 * If git is unavailable (no repo / git not installed), only the internal
 * exclusions apply; everything else is treated as user source code.
 */
async function isReviewableWritePath(uri: vscode.Uri): Promise<boolean> {
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  if (!ws) return false;
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (!rel) return false;
  // Always exclude internal/special directories that git check-ignore
  // won't catch (.git is implicitly ignored by git itself).
  if (rel === '.burstcode' || rel.startsWith('.burstcode/')) return false;
  if (rel === '.git' || rel.startsWith('.git/')) return false;
  // Primary: use git check-ignore for accurate .gitignore-based filtering.
  const ignored = await gitCheckIgnored(ws.uri.fsPath, rel);
  if (ignored) return false;
  return true;
}

export function buildWriteFileTool(applier?: HunkApplier, sessionId?: string, turnIndex?: number): Tool {
  return {
    name: 'write_file',
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write or append a file on disk immediately, then queue the before/after file snapshot for user review in the pending edits UI. Reject restores the previous content or deletes a newly-created file; Accept keeps the already-written content. Use for agent-generated helper scripts, temp files, config stubs, and any file the agent needs to create and then immediately execute or read back. Parent directories are created automatically. Default mode overwrites the file. Set mode="append" (or append=true) ONLY when continuing a previously interrupted/partial write_file output after reading the current tail; do not resend already-written content. If writing a whole file / large content fails, is truncated, cannot parse, or produces no landed change, DO NOT retry the same giant payload; read back the current file and split the work into smaller generated files/chunks or append/repair only the missing tail in follow-up calls.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
            content: { type: 'string', description: 'Full file contents to write, or only the missing tail when mode="append".' },
            mode: { type: 'string', enum: ['write', 'append'], description: 'Default "write" overwrites. Use "append" to continue an interrupted partial write_file after reading the file tail.' },
            append: { type: 'boolean', description: 'Alias for mode="append". Use only to continue a partial write; never resend already-written bytes.' }
          },
          required: ['path', 'content']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.path ?? '').trim();
      if (!target) return { content: 'write_file: path is required', isError: true };
      const content = String(args.content ?? '');
      const appendMode = args.mode === 'append' || args.append === true || args.append === 'true';
      const uri = resolveUri(target);
      const fsModule = await import('fs/promises');
      const nodePath = await import('path');
      try {
        await fsModule.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
        let existed = false;
        let originalContent: string | null = null;
        try {
          originalContent = await fsModule.readFile(uri.fsPath, 'utf8');
          existed = true;
        } catch { existed = false; }
        if (appendMode) {
          await fsModule.appendFile(uri.fsPath, content, 'utf8');
        } else {
          await fsModule.writeFile(uri.fsPath, content, 'utf8');
        }
        const modifiedContent = await fsModule.readFile(uri.fsPath, 'utf8');
        // Bind this write to the current session and show it in the normal
        // pending review UI so Reject can restore the captured pre-write state.
        // Skip review for paths that are git-ignored (per the project's .gitignore)
        // or internal infrastructure (.burstcode, .git) — these are not user source.
        try {
          if (applier && originalContent !== modifiedContent && await isReviewableWritePath(uri)) {
            await applier.queueExternalFileChange(
              uri,
              originalContent,
              modifiedContent,
              appendMode ? 'write_file append' : 'write_file write',
              sessionId,
              turnIndex
            );
          }
        } catch { /* non-fatal: disk write already succeeded */ }
        const relPath = vscode.workspace.asRelativePath(uri);
        const truncationNote = args.__bc_truncatedSalvage
          ? ' IMPORTANT: this write_file call was TRUNCATED mid-stream; the partial content that arrived was written to disk. Read the file back and append/repair only the missing tail in a smaller follow-up call using mode="append" when the tail is strictly additive.'
          : '';
        const verb = appendMode ? 'Appended' : 'Written';
        const suffix = appendMode ? ' (append mode)' : '';
        return {
          content: `${verb} ${content.split(/\r?\n/).length} line(s) to ${relPath}${suffix}.${truncationNote}`,
          meta: { uri: uri.toString(), bytes: Buffer.byteLength(content, 'utf8'), created: !existed, mode: appendMode ? 'append' : 'write', pendingReview: Boolean(applier) }
        };
      } catch (err) {
        return {
          content:
            `write_file failed: ${String((err as Error).message ?? err)}. ` +
            `If this was a whole-file or large-content write, do not retry the same oversized payload. ` +
            `Read the current file state/tail, then split the work into smaller write_file/propose_edit calls ` +
            `(for write_file, use mode="append" only for the missing tail; otherwise repair the smallest incorrect block).`,
          isError: true
        };
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
// collect_context is intentionally convenient, so it also needs a hard output
// budget: a single broad call (many reads / full files / large greps) otherwise
// lands as one huge tool_result and can blow the next LLM request before the
// normal older-history compressor gets a chance to help.
const CC_MAX_SECTION_CHARS = 14_000;
const CC_MAX_TOTAL_CHARS = 64_000;

export function buildCollectContextTool(applier?: HunkApplier, sessionId?: string): Tool {
  const readFileTool = buildReadFileTool(applier, sessionId);

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
                  endLine: { type: 'number', description: '1-indexed end line (inclusive). Defaults to startLine+200; collect_context returns only this slice, not the whole file.' },
                  full: { type: 'boolean', description: 'When true, read from startLine through the file end. Use sparingly; prefer targeted windows for large files.' }
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
      let truncatedCount = 0;
      settled.forEach((s, i) => {
        const label = tasks[i].label;
        if (s.status === 'fulfilled') {
          if (s.value.isError) errorCount++;
          const tag = s.value.isError ? ' [error]' : '';
          const raw = s.value.content;
          const body = raw.length > CC_MAX_SECTION_CHARS
            ? truncateMiddleText(raw, Math.floor(CC_MAX_SECTION_CHARS * 0.55), Math.floor(CC_MAX_SECTION_CHARS * 0.35))
            : raw;
          if (body !== raw) truncatedCount++;
          sections.push(`===== ${label}${tag} =====\n${body}`);
        } else {
          errorCount++;
          sections.push(`===== ${label} [failed] =====\n${String(s.reason)}`);
        }
      });

      let body = sections.join('\n\n');
      if (body.length > CC_MAX_TOTAL_CHARS) {
        body = truncateMiddleText(body, Math.floor(CC_MAX_TOTAL_CHARS * 0.58), Math.floor(CC_MAX_TOTAL_CHARS * 0.34));
        truncatedCount++;
      }

      const truncateNote = truncatedCount > 0
        ? `, ${truncatedCount} truncated (output capped; use narrower files/searches or read_file for exact missing ranges)`
        : '';
      const header = `# collect_context: ${tasks.length} source(s), ${errorCount} error(s)${truncateNote}`;
      return {
        content: `${header}\n\n${body}`,
        meta: { tasks: tasks.length, errors: errorCount, truncated: truncatedCount > 0 },
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
