import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';
import { HunkApplier, ProposedEditFile } from '../../edits/HunkApplier';
import { repairJsonControlChars, repairJsonUnescapedQuotes } from '../../util/jsonRepair';

/**
 * Return the first string-typed value found at any of `keys` on `obj`, along
 * with the actual key that hit. Used to forgive the LLM's frequent drift
 * away from canonical schema field names (e.g. `file` instead of `path`,
 * `replacement` instead of `newText`). Returns `undefined` when no key
 * present yields a string. Empty strings are preserved (callers that care
 * about emptiness — e.g. path validation — check the returned `value`
 * themselves, but `newText` legitimately can be empty for deletions).
 */
function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[]
): { value: string; key: string } | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return { value: v, key: k };
  }
  return undefined;
}

function pickFiniteNumber(obj: Record<string, unknown>, key: string): number | undefined {
  if (obj[key] === undefined) return undefined;
  const n = Number(obj[key]);
  return Number.isFinite(n) ? n : undefined;
}

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
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeSalvagedEdit(
  raw: unknown,
  fallbackPath?: { value: string; key: string }
): Record<string, unknown> | null {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const pathPicked = pickFirstString(e, [
    'path',
    'file',
    'filePath',
    'filename',
    'fileName',
    'target',
    'targetFile',
    'uri'
  ]) ?? fallbackPath;
  const newTextPicked = pickFirstString(e, ['newText', 'new_text', 'replacement', 'code', 'content', 'text']);
  const oldTextPicked = pickFirstString(e, ['oldText', 'old_text', 'original', 'search']);
  const startLine = pickFiniteNumber(e, 'startLine');
  const endLine = pickFiniteNumber(e, 'endLine');
  if (!pathPicked || !newTextPicked) return null;
  if (!oldTextPicked && (startLine === undefined || endLine === undefined)) return null;
  return {
    path: pathPicked.value,
    newText: newTextPicked.value,
    ...(oldTextPicked ? { oldText: oldTextPicked.value } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {})
  };
}

function mergeSalvagedEdits(primary: unknown[], secondary: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const e of [...primary, ...secondary]) {
    const sig = JSON.stringify(e);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(e);
  }
  return out;
}

function findJsonValueEnd(text: string, start: number): number {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) return i;
      stack.pop();
      if (stack.length === 0) return i + 1;
      continue;
    }
    if (stack.length === 0 && ch === ',') return i;
  }
  return -1;
}

function extractCompleteObjectsFromArrayField(text: string, field: string): unknown[] {
  const fieldRe = new RegExp(`"${field}"\\s*:\\s*\\[`, 'g');
  const m = fieldRe.exec(text);
  if (!m) return [];
  const out: unknown[] = [];
  let pos = m.index + m[0].length;
  while (pos < text.length) {
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    if (text[pos] === ']') break;
    if (text[pos] !== '{') break;
    const end = findJsonValueEnd(text, pos);
    if (end < 0) break;
    const rawObj = text.slice(pos, end);
    try {
      out.push(JSON.parse(rawObj));
    } catch {
      const controlRepaired = repairJsonControlChars(rawObj) ?? rawObj;
      const quoteRepaired = repairJsonUnescapedQuotes(controlRepaired) ?? controlRepaired;
      try { out.push(JSON.parse(quoteRepaired)); } catch { /* skip malformed fragment */ }
    }
    pos = end;
  }
  return out;
}

function parseLooseStringifiedEdits(
  text: string,
  fallbackPath?: { value: string; key: string }
): unknown[] {
  // This is the backend equivalent of the webview's live streamed preview: if a
  // propose_edit args buffer has already streamed one or more complete edit
  // objects inside edits:[...], salvage those objects even when the OUTER tool
  // JSON was interrupted before it could close / execute. Do not regex individual
  // oldText/newText fields globally — that mixes fields from different hunks and
  // is exactly how a visible per-hunk "fragment" can be lost or corrupted.
  return extractCompleteObjectsFromArrayField(text, 'edits')
    .map((e) => normalizeSalvagedEdit(e, fallbackPath))
    .filter((e): e is Record<string, unknown> => !!e);
}

/**
 * Best-effort recovery of a TRUNCATED propose_edit tool call. When the model
 * runs out of output budget mid-call its raw arguments are cut off and the
 * normal JSON.parse / repair passes all fail because there is no complete
 * object to parse. This salvages whatever WHOLE {path, newText, ...} edit
 * fragments DID arrive — plus the same renderable per-edit objects that the
 * webview's live preview can already show by synthetically closing the partial
 * JSON — so a visible edit card is not lost just because the outer tool call
 * never reached execution. The half-written tail fragment may still be skipped
 * if it lacks path/newText plus oldText or a line range. Returns null when not a
 * single complete/renderable fragment could be recovered.
 */
export function salvageProposeEditArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Native OpenAI tool-call streams often use the canonical compact shape
  // {summary, path, edits:[{oldText,newText}, ...]} while the outer JSON may be
  // cut before it closes. The normal execute() path propagates top-level path to
  // each edit; the interruption salvage must do the same or every fully-written
  // edit object is skipped for "missing path" and never reaches HunkApplier.
  const fallbackPath = pickLooseStringField(raw, [
    'path',
    'file',
    'filePath',
    'filename',
    'fileName',
    'target',
    'targetFile',
    'uri'
  ]);
  const looseEdits = parseLooseStringifiedEdits(raw, fallbackPath);
  const partialParsed = parsePartialJsonObject(raw);
  const parsedPath = partialParsed
    ? pickFirstString(partialParsed, [
        'path',
        'file',
        'filePath',
        'filename',
        'fileName',
        'target',
        'targetFile',
        'uri'
      ]) ?? fallbackPath
    : fallbackPath;
  const rawParsedEdits = partialParsed && Array.isArray(partialParsed.edits)
    ? partialParsed.edits
    : [];
  const previewEdits = rawParsedEdits
    .map((e) => normalizeSalvagedEdit(e, parsedPath))
    .filter((e): e is Record<string, unknown> => !!e);
  if (partialParsed && previewEdits.length === 0) {
    const topLevelEdit = normalizeSalvagedEdit(partialParsed, parsedPath);
    if (topLevelEdit) previewEdits.push(topLevelEdit);
  }
  const edits = mergeSalvagedEdits(looseEdits, previewEdits);
  if (edits.length === 0) return null;
  const summary =
    pickLooseStringField(raw, ['summary'])?.value ??
    '(recovered from a truncated propose_edit call)';
  return { summary, edits, __bc_truncatedSalvage: true };
}

/** A single answer choice presented to the user. */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** Spec for a clarifying question raised by the agent. */
export interface AskUserSpec {
  question: string;
  /** 'single' = pick one option, 'multi' = pick zero-or-more, 'text' = free text only. */
  inputType: 'single' | 'multi' | 'text';
  options?: AskUserOption[];
  /** When true, also show a free-text field alongside the options (for "other"-style answers). */
  allowCustomText?: boolean;
  placeholder?: string;
}

export type AskUserFn = (spec: AskUserSpec) => Promise<string>;

function resolveToolPath(p: string): vscode.Uri {
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, p) : vscode.Uri.file(p);
}

function splitPreviewLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.split('\n');
}

async function buildDeletionPreviewEdits(files: ProposedEditFile[]): Promise<Array<Record<string, unknown>>> {
  const preview: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const deletionHunks = f.hunks.filter(
      (h) => h.oldText === undefined && h.newText === '' && h.startLine <= h.endLine
    );
    if (deletionHunks.length === 0) continue;
    try {
      const uri = resolveToolPath(f.path);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const lines = splitPreviewLines(text);
      for (const h of deletionHunks) {
        const startIdx = Math.max(0, h.startLine - 1);
        const endIdx = Math.max(startIdx, h.endLine);
        preview.push({
          path: f.path,
          startLine: h.startLine,
          endLine: h.endLine,
          oldText: lines.slice(startIdx, endIdx).join('\n'),
          newText: ''
        });
      }
    } catch {
      // Best-effort UI metadata only; the real applier still validates/applies below.
    }
  }
  return preview;
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'diagnostic';
  }
}

async function buildPostEditDiagnosticsNote(files: ProposedEditFile[]): Promise<string> {
  // Diagnostics are refreshed asynchronously by language extensions after the
  // eager disk write. A short yield catches most syntax/parser updates without
  // turning propose_edit into a build/test runner.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const rows: string[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const f of files) {
    const uri = resolveToolPath(f.path);
    const diagnostics = vscode.languages.getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
      .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
    for (const d of diagnostics) {
      if (d.severity === vscode.DiagnosticSeverity.Error) totalErrors++;
      if (d.severity === vscode.DiagnosticSeverity.Warning) totalWarnings++;
      if (rows.length >= 12) continue;
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const source = d.source ? ` [${d.source}]` : '';
      rows.push(`- ${f.path}:${line}:${col} ${diagnosticSeverityName(d.severity)}${source}: ${String(d.message).replace(/\s+/g, ' ')}`);
    }
  }

  if (totalErrors === 0 && totalWarnings === 0) return '';
  const omitted = totalErrors + totalWarnings - rows.length;
  const omittedNote = omitted > 0 ? `\n- ... ${omitted} more diagnostic(s) omitted` : '';
  const repairMode = totalErrors > 0
    ? `\nACTION REQUIRED — VS Code now reports error diagnostics in the file(s) you just edited. Treat this as evidence the edit may have broken syntax/types or garbled the file. Before continuing feature work, read the reported line(s) with a small surrounding range and repair the smallest concrete issue. For missing/wrong braces, brackets, parentheses, tags, or quotes, patch only the unmatched/extra delimiter or tiny enclosing block, then run the relevant compiler/parser check. If diagnostics are widespread/cascading or the file looks corrupted, switch to recovery mode: inspect the whole file when feasible, otherwise restore from git/checkpoint and reapply smaller hunks.`
    : `\nNOTE — VS Code reports warning diagnostics in the file(s) you just edited. Consider checking the reported ranges before moving on.`;
  return `\nPOST-EDIT DIAGNOSTICS (${totalErrors} error(s), ${totalWarnings} warning(s)):\n${rows.join('\n')}${omittedNote}${repairMode}`;
}

export function buildEditTools(
  applier: HunkApplier,
  askUser: AskUserFn,
  sessionId?: string,
  turnIndex?: number
): Tool[] {
  const proposeEdit: Tool = {
    name: 'propose_edit',
    // Concurrent-safe: HunkApplier serializes per-file mutations through an
    // internal mutex, deduplicates the pre-edit git checkpoint, and only
    // opens a diff editor for the first newly-queued file in a review cycle.
    // Different files therefore queue in parallel within a single assistant
    // turn (and across concurrent sub-agent runs).
    parallelSafe: true,
    schema: {
      type: 'function',
      function: {
        name: 'propose_edit',
        description:
          "Apply edits to one or more files IMMEDIATELY — they land on disk as soon as this tool returns and the user can compile / run with them right away. The changes are ALSO staged for user review; Accept simply marks them as finalized, while Reject rolls the affected hunks back to the original content. Use this for modifications to the user's existing source files. For agent-generated scripts or temp files you'll execute immediately, use write_file instead. If a whole-file / large-fragment edit fails, is truncated, cannot parse, or lands nothing, DO NOT retry the same giant payload — re-read the current file and split the work into smaller ordered propose_edit calls, one hunk/function/section at a time, so each piece can land independently.\n\n" +
          "FAST DELETE-LINES MODE: when the intended edit is ONLY deleting whole line ranges, set operation='delete_lines' and pass either {path,startLine,endLine} for one range or {ranges:[{path,startLine,endLine}, ...]} for batches. Do NOT pass oldText/newText in this mode; propose_edit internally emits line-range deletion hunks with newText:'' and no oldText, avoiding the empty-oldText trap.\n\n" +
          "RECOMMENDED FORM (anchor-based, robust to line drift): supply 'oldText' = the EXACT contiguous lines you want to replace (whitespace-exact, full lines). 'newText' is what they become. The applier locates oldText in the file's current view and rewrites the line range for you, so stale line numbers no longer corrupt edits. If oldText appears multiple times, set 'startLine' to the 1-indexed line where the intended match starts as a tie-breaker, OR add more context lines to oldText to make it unique.\n\n" +
          "FALLBACK FORM (line-range, used when oldText is omitted): supply 1-indexed inclusive [startLine, endLine] matching the on-disk content you see via read_file (propose_edit writes eagerly, so read_file already shows the live post-edit state; the `pending hunks` footnote is just metadata — not a separate layer). To INSERT without replacing in this form, set startLine = endLine + 1 and end newText with a newline.\n\n" +
          "CREATING A NEW FILE: set path to the new file path (parent dirs auto-created), startLine=1, endLine=0, omit oldText, and put the full file contents in newText. Do NOT stuff new code into an unrelated existing file just because the target doesn't exist yet — propose_edit handles file creation natively.\n\n" +
          "You may call propose_edit multiple times within a turn (and across turns) to refine the queued change set. Later hunks that fully contain earlier pending hunks replace them (last-write-wins); partially-overlapping hunks are REJECTED with a clear error so you can retarget. After any fragment has landed, treat the live file as the baseline: do not append or regenerate a broad replacement for the same area. If you need to fix overlap/duplication, re-read the exact current range and use oldText to replace the concrete bad block or delete_lines to remove the duplicate block. The user accepts/rejects via a chat banner or per-hunk CodeLenses; Accept is a status-only flip (the on-disk bytes don't change), while Reject rewinds to the pre-edit snapshot. When you receive a [user-decision] notice, re-read the affected file — a Reject may have rolled content back.",
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One-paragraph human summary.' },
            operation: {
              type: 'string',
              enum: ['edit', 'delete_lines'],
              description: "Optional mode selector. Use 'delete_lines' for pure line-range deletion with path/startLine/endLine or ranges[]. Omit or use 'edit' for normal edits[]."
            },
            path: { type: 'string', description: "Single-file shortcut for operation='delete_lines', or fallback path for edits[]." },
            startLine: { type: 'number', description: "Single-range shortcut for operation='delete_lines'. 1-indexed inclusive first line to delete." },
            endLine: { type: 'number', description: "Single-range shortcut for operation='delete_lines'. 1-indexed inclusive last line to delete." },
            ranges: {
              type: 'array',
              description: "Batch form for operation='delete_lines'. Each range deletes whole lines and must include path/startLine/endLine.",
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' }
                },
                required: ['path', 'startLine', 'endLine']
              }
            },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  oldText: {
                    type: 'string',
                    description:
                      "RECOMMENDED. Exact contiguous lines to replace, whitespace-exact and aligned to whole lines. When set, startLine/endLine become hints (only used to disambiguate non-unique matches). Omit only when creating a new file or when you genuinely want pure line-range mode."
                  },
                  startLine: {
                    type: 'number',
                    description:
                      "1-indexed inclusive start. Required in line-range mode. Optional disambiguation hint when oldText is supplied."
                  },
                  endLine: {
                    type: 'number',
                    description:
                      "1-indexed inclusive end. Required in line-range mode. Ignored when oldText is supplied."
                  },
                  newText: {
                    type: 'string',
                    description: 'Replacement text. Use the empty string to delete oldText / the line range without inserting anything.'
                  }
                },
                required: ['path', 'newText']
              }
            }
          },
          required: ['summary']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      // Compression-artifact guard: the Compressor replaces the arguments of
      // OLD historical tool_calls with an elided marker to save tokens. If the
      // model imitates that shape on a fresh call (e.g. emits `{_truncated: ..}`
      // or only the elided marker key as its entire args), give a targeted
      // error instead of the generic schema message — otherwise the model
      // keeps copying the artifact and loops. See Compressor truncation logic.
      const argKeys = Object.keys((args ?? {}) as Record<string, unknown>);
      const looksLikeElidedArtifact =
        argKeys.length > 0 &&
        argKeys.every((k) => k === '_truncated' || k === '_elided' || k === '_omitted');
      if (looksLikeElidedArtifact) {
        return {
          content:
            'no edits provided: the arguments only contain a compression placeholder ' +
            `key ([${argKeys.join(', ')}]). That marker is an artifact of an OLD ` +
            'truncated tool call in the history — it is NOT a valid argument shape. ' +
            'Re-emit propose_edit with the real {summary, edits: [{path, newText, oldText?}]} ' +
            'payload containing the actual code you want to change.',
          isError: true
        };
      }
      const summary = String(args.summary ?? '');
      // Accept a few common alias keys (`hunks`, `changes`, `files`) for
      // `edits` — the model occasionally picks one of these on the first
      // call. Without this, a naming slip caused the LLM to loop on
      // "no edits provided" because the downstream message didn't tell it
      // which key it actually used.
      const argsRecord = (args ?? {}) as Record<string, unknown>;
      // Top-level path fallback: when the model emits {summary, path, edits:
      // [{oldText, newText}, ...]} (a single-file convenience form it
      // sometimes invents), propagate that path to every hunk that lacks
      // its own. Cheap to support; expensive to debug when missing.
      const topLevelPath = pickFirstString(argsRecord, [
        'path',
        'file',
        'filePath',
        'filename',
        'fileName',
        'target',
        'targetFile',
        'uri'
      ]);
      const rawEditsCandidate =
        (args as Record<string, unknown>).edits ??
        (args as Record<string, unknown>).hunks ??
        (args as Record<string, unknown>).changes ??
        (args as Record<string, unknown>).files;
      const usedAlias =
        !Array.isArray((args as Record<string, unknown>).edits) && Array.isArray(rawEditsCandidate)
          ? Object.keys(args as Record<string, unknown>).find(
              (k) => k !== 'edits' && Array.isArray((args as Record<string, unknown>)[k])
            )
          : undefined;
      let rawEdits: unknown[];
      let stringifiedEditsParseFailed = false;
      if (Array.isArray(rawEditsCandidate)) {
        rawEdits = rawEditsCandidate;
      } else if (typeof rawEditsCandidate === 'string') {
        try {
          const parsed = JSON.parse(rawEditsCandidate);
          rawEdits = Array.isArray(parsed) ? parsed : [];
        } catch {
          // LLM often emits literal newlines/tabs inside JSON string values.
          // Try the same control-char repair used for top-level tool args.
          // Pass 1: fix raw control chars (literal \n, \t, etc. inside strings).
          const controlRepaired = repairJsonControlChars(rawEditsCandidate);
          const afterControl = controlRepaired ?? rawEditsCandidate;
          let parsedInner: unknown = null;
          try {
            parsedInner = JSON.parse(afterControl);
          } catch {
            // Pass 2: fix unescaped " inside strings (e.g. Python """ docstrings).
            const quoteRepaired = repairJsonUnescapedQuotes(afterControl);
            if (quoteRepaired !== null) {
              try { parsedInner = JSON.parse(quoteRepaired); } catch { /* give up */ }
            }
          }
          if (Array.isArray(parsedInner)) {
            rawEdits = parsedInner;
          } else {
            const quoteRepaired = repairJsonUnescapedQuotes(afterControl);
            rawEdits = parseLooseStringifiedEdits(quoteRepaired ?? afterControl, topLevelPath);
            stringifiedEditsParseFailed = rawEdits.length === 0;
          }
        }
      } else {
        rawEdits = [];
      }
      // Delete-lines convenience mode: keep a single public write tool, but let
      // the caller explicitly choose a safe line-deletion shape that never
      // carries oldText. This avoids adding another tool while preventing the
      // common oldText:"" footgun.
      const operation = String(
        argsRecord.operation ?? argsRecord.mode ?? argsRecord.action ?? ''
      ).toLowerCase().replace(/[\s-]+/g, '_');
      const rawRangesCandidate =
        (argsRecord as Record<string, unknown>).ranges ??
        (argsRecord as Record<string, unknown>).deletions ??
        (argsRecord as Record<string, unknown>).deleteRanges;
      const wantsDeleteLines =
        ['delete_lines', 'delete', 'delete_range', 'delete_ranges', 'remove_lines'].includes(operation) ||
        Array.isArray(rawRangesCandidate);
      let synthesizedDeleteLines = false;
      if (rawEdits.length === 0 && wantsDeleteLines) {
        const rawRanges = Array.isArray(rawRangesCandidate) && rawRangesCandidate.length > 0
          ? rawRangesCandidate
          : [argsRecord];
        rawEdits = rawRanges.map((rawRange) => {
          const r = rawRange && typeof rawRange === 'object'
            ? (rawRange as Record<string, unknown>)
            : {};
          const rangePath = pickFirstString(r, [
            'path',
            'file',
            'filePath',
            'filename',
            'fileName',
            'target',
            'targetFile',
            'uri'
          ]) ?? topLevelPath;
          return {
            ...(rangePath ? { [rangePath.key]: rangePath.value } : {}),
            startLine: r.startLine ?? r.start ?? r.fromLine ?? r.from,
            endLine: r.endLine ?? r.end ?? r.toLine ?? r.to,
            newText: ''
          };
        });
        synthesizedDeleteLines = true;
      }
      // Flattened-single-edit fallback: the model FREQUENTLY emits a single
      // edit's fields at the TOP LEVEL with no wrapping array at all —
      // {summary, path, oldText, newText} — instead of the canonical
      // {summary, edits: [{...}]}. When we ended up with zero edits but the
      // top-level args themselves carry a usable edit (a path plus newText or
      // oldText), synthesize a one-element edits array from them. This turns
      // the most common first-call failure into a transparent success.
      let synthesizedFromTopLevel = false;
      if (rawEdits.length === 0 && topLevelPath) {
        const topNewText = pickFirstString(argsRecord, ['newText', 'new_text', 'replacement', 'code', 'content', 'text']);
        const topOldText = pickFirstString(argsRecord, ['oldText', 'old_text', 'original', 'search']);
        if (topNewText || topOldText) {
          rawEdits = [{
            [topLevelPath.key]: topLevelPath.value,
            ...(topNewText ? { [topNewText.key]: topNewText.value } : {}),
            ...(topOldText ? { [topOldText.key]: topOldText.value } : {}),
            ...(argsRecord.startLine !== undefined ? { startLine: argsRecord.startLine } : {}),
            ...(argsRecord.endLine !== undefined ? { endLine: argsRecord.endLine } : {})
          }];
          synthesizedFromTopLevel = true;
        }
      }
      const grouped = new Map<string, ProposedEditFile>();
      const skipReasons: string[] = [];
      let aliasedPathKey: string | undefined;
      for (let i = 0; i < rawEdits.length; i++) {
        const e = (rawEdits[i] ?? {}) as Record<string, unknown>;
        // Accept common path-field aliases. The `edit_*` / `replacement` /
        // `code` aliases for newText are also forgiven below — together they
        // cover ~all of the LLM's drift away from the canonical schema.
        let pathPicked = pickFirstString(e, [
          'path',
          'file',
          'filePath',
          'filename',
          'fileName',
          'target',
          'targetFile',
          'uri'
        ]);
        if (!pathPicked && topLevelPath) pathPicked = { value: topLevelPath.value, key: topLevelPath.key };
        const path = pathPicked?.value ?? '';
        if (pathPicked && pathPicked.key !== 'path' && !aliasedPathKey) aliasedPathKey = pathPicked.key;
        const newTextPicked = pickFirstString(e, ['newText', 'new_text', 'replacement', 'code', 'content', 'text']);
        const newText = newTextPicked?.value ?? '';
        const oldTextPicked = pickFirstString(e, ['oldText', 'old_text', 'original', 'search']);
        const startLineRaw = e.startLine === undefined ? NaN : Number(e.startLine);
        const endLineRaw = e.endLine === undefined ? NaN : Number(e.endLine);
        const hasEmptyOldTextDeleteRange =
          oldTextPicked?.value === '' &&
          newText === '' &&
          Number.isFinite(startLineRaw) &&
          Number.isFinite(endLineRaw) &&
          startLineRaw <= endLineRaw;
        const hasOldText = oldTextPicked !== undefined && !hasEmptyOldTextDeleteRange;
        if (!path) {
          const presentKeys = Object.keys(e);
          skipReasons.push(
            `edits[${i}]: missing 'path' — keys present: [${presentKeys.join(', ') || '(none)'}]`
          );
          continue;
        }
        // oldText form: line numbers optional (used as hint).
        // Line-range form: both startLine and endLine required. Treat
        // oldText:"" + newText:"" + a valid non-empty line range as the
        // intended line-range deletion, because models often include the empty
        // optional field even when they mean to omit it.
        if (!hasOldText && (!Number.isFinite(startLineRaw) || !Number.isFinite(endLineRaw))) {
          skipReasons.push(
            `edits[${i}] (${path}): no 'oldText' was supplied AND startLine/endLine are not finite numbers — supply oldText, or both line numbers`
          );
          continue;
        }
        const entry = grouped.get(path) ?? { path, hunks: [] };
        entry.hunks.push({
          startLine: Number.isFinite(startLineRaw) ? startLineRaw : 0,
          endLine: Number.isFinite(endLineRaw) ? endLineRaw : 0,
          newText,
          ...(hasOldText ? { oldText: oldTextPicked!.value } : {})
        });
        grouped.set(path, entry);
      }
      const files = Array.from(grouped.values());
      if (files.length === 0) {
        const argsObj = (args ?? {}) as Record<string, unknown>;
        const presentKeys = Object.keys(argsObj);
        const editsField = argsObj.edits;
        const diagnosis = !Array.isArray(editsField)
          ? editsField === undefined
            ? `'edits' field is missing. Received top-level keys: [${presentKeys.join(', ') || '(none)'}]. The schema requires {summary: string, edits: array<{path, newText, oldText?, startLine?, endLine?}>}`
            : typeof editsField === 'string' && stringifiedEditsParseFailed
              ? `'edits' was a string and could not be parsed as a complete edits array. It is likely malformed or truncated inside a large newText value (received ${editsField.length} chars; head: ${JSON.stringify(editsField).slice(0, 160)}). Re-emit smaller propose_edit calls, one file/hunk at a time. Do not switch to write_file for user project source changes; write_file bypasses review/rollback and is only appropriate for temporary/generated files that will be executed immediately.`
              : `'edits' was not an array (got ${typeof editsField}: ${JSON.stringify(editsField).slice(0, 120)})`
          : editsField.length === 0
            ? "'edits' array was empty"
            : `all ${editsField.length} edit(s) were skipped: ${skipReasons.join('; ')}`;
        return { content: `no edits provided: ${diagnosis}. Re-emit propose_edit with a valid 'edits' array.`, isError: true };
      }
      const deletionPreviewEdits = await buildDeletionPreviewEdits(files);
      try {
        await applier.proposeEdits(files, summary, sessionId, turnIndex);
      } catch (err) {
        // proposeEdits throws on overlap-rejection (new hunks that clash with
        // already-accepted regions, partially overlap pending hunks, or
        // overlap each other within the same call) and on oldText resolution
        // failure. Per-file errors are aggregated; files that succeeded ARE
        // already queued and visible in the chat banner — only the named
        // files need re-targeting.
        const message = err instanceof Error ? err.message : String(err);
        const diagnosticsNote = await buildPostEditDiagnosticsNote(files);
        return {
          content:
            `propose_edit applied every VALID fragment and staged it on disk; only the ` +
            `fragment(s) below failed and were skipped (the rest of the same call still landed):\n${message}\n` +
            `RECOVERY REQUIRED — before making another edit, inspect the current file state: read the whole affected file with read_file when it is reasonably sized; if it is too large or appears corrupted/garbled, restore it from git/checkpoint first. Then write a short revised plan and switch strategy instead of repeating the same failing edit shape. ` +
            `If the failure looks like missing/wrong braces, brackets, parentheses, tags, or quotes, treat it as a syntax-structure repair: read the smallest block that includes the broken delimiter plus neighboring function/class boundaries, patch only the unmatched/extra delimiter or tiny enclosing block, and run the relevant compiler/parser check before any broader rewrite. ` +
            `Re-issue ONLY the failed fragment(s) above: re-read the relevant current range because landed fragments may have shifted line numbers, then submit smaller hunks with precise oldText / non-overlapping ranges, use delete_lines for exact duplicate blocks, or use a temporary scripted replacement for controlled broad changes. ` +
            `Do NOT regenerate or append a broad replacement for code that already landed; that creates duplicate code and file bloat. ` +
            `Prefer the oldText form so line drift no longer matters.\n` +
            `Do NOT re-submit any fragment or file that was not named above — those are already staged and need no further action from you.` +
            diagnosticsNote,
          isError: true,
          meta: deletionPreviewEdits.length ? { previewEdits: deletionPreviewEdits } : undefined
        };
      }
      const diagnosticsNote = await buildPostEditDiagnosticsNote(files);
      const aliasNotes: string[] = [];
      if (synthesizedFromTopLevel) {
        aliasNotes.push(
          "edit fields (path/newText/oldText) were sent at the TOP LEVEL with no 'edits' array; wrapped them into edits:[{...}] for you"
        );
      }
      if (usedAlias) {
        aliasNotes.push(`top-level field 'edits' was sent as '${usedAlias}'`);
      }
      if (synthesizedDeleteLines) {
        aliasNotes.push(
          "operation='delete_lines' was converted into normal line-range deletion hunks with newText:'' and no oldText"
        );
      }
      if (aliasedPathKey) {
        aliasNotes.push(`per-edit field 'path' was sent as '${aliasedPathKey}'`);
      }
      const aliasNote = aliasNotes.length
        ? `\nNote: ${aliasNotes.join('; ')}. Accepted this time — please use the canonical field names ('edits', 'path') on subsequent calls.`
        : '';
      const filePaths = files.map((f) => f.path).join(', ');
      const truncationNote = argsRecord.__bc_truncatedSalvage
        ? `\nIMPORTANT: your propose_edit call was TRUNCATED mid-stream (output token budget). Only the ${rawEdits.length} fully-received fragment(s) above were recovered and applied; any edits after the cut-off point were lost. Re-issue the REMAINING edits in a new, smaller propose_edit call.`
        : '';
      return {
        content: `Queued edits for ${files.length} file(s): ${filePaths} — pending user review (non-blocking). You may call propose_edit again to add or replace hunks, or move on to the next step.${aliasNote}${truncationNote}${diagnosticsNote}`,
        meta: {
          files: files.map((f) => f.path),
          summary,
          ...(deletionPreviewEdits.length ? { previewEdits: deletionPreviewEdits } : {})
        }
      };
    }
  };

  const askUserTool: Tool = {
    name: 'ask_user',
    // Blocks on a user prompt and post-back; never run alongside other tools.
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Pause the run and ask the user a clarifying question whenever the request is ambiguous OR you discover ambiguity mid-task (e.g. multiple matching files/symbols, two plausible interpretations, missing piece of info, choice between approaches). DO NOT silently pick one — call this tool. Pick the right inputType for the situation:\n' +
          "  - 'single': user must pick exactly one option (e.g. 'which of these files did you mean?').\n" +
          "  - 'multi':  user picks zero or more options (e.g. 'which of these refactors should I apply?'). Returned answer is a comma-separated list of labels.\n" +
          "  - 'text':   free-text input only, no preset options (e.g. 'what should the new API endpoint be named?').\n" +
          "Set allowCustomText=true alongside 'single' or 'multi' to ALSO show a free-text field for an 'other' answer. The tool blocks until the user submits and returns their raw answer.",
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The clarifying question, phrased so the user can answer without re-reading the chat.'
            },
            inputType: {
              type: 'string',
              enum: ['single', 'multi', 'text'],
              description:
                "How the user should answer: 'single' (radio), 'multi' (checkboxes), or 'text' (free text). Required."
            },
            options: {
              type: 'array',
              description:
                "Choices presented to the user. Required for 'single' and 'multi'; omit for 'text'. NEVER include an 'other' option — set allowCustomText=true instead.",
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short label shown on the button / checkbox.' },
                  description: {
                    type: 'string',
                    description: 'Optional longer explanation rendered under the label.'
                  }
                },
                required: ['label']
              }
            },
            allowCustomText: {
              type: 'boolean',
              description:
                "When true (and inputType is 'single' or 'multi'), also show a free-text input so the user can type a custom answer instead of / in addition to picking options."
            },
            placeholder: {
              type: 'string',
              description: 'Optional placeholder text for the free-text input.'
            }
          },
          required: ['question', 'inputType']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const question = String(args.question ?? '').trim();
      if (!question) {
        return { content: 'ask_user requires a non-empty question.', isError: true };
      }

      const rawType = String(args.inputType ?? '').toLowerCase();
      const rawOptions = Array.isArray(args.options) ? (args.options as unknown[]) : [];
      const options: AskUserOption[] = rawOptions
        .map((o) => {
          if (typeof o === 'string') return { label: o };
          if (o && typeof o === 'object') {
            const rec = o as Record<string, unknown>;
            const label = String(rec.label ?? '').trim();
            if (!label) return null;
            const description = rec.description ? String(rec.description) : undefined;
            return { label, description };
          }
          return null;
        })
        .filter((o): o is AskUserOption => !!o);

      let inputType: 'single' | 'multi' | 'text';
      if (rawType === 'single' || rawType === 'multi' || rawType === 'text') {
        inputType = rawType;
      } else {
        // Be forgiving: infer from options when the model omits / mistypes inputType.
        inputType = options.length > 0 ? 'single' : 'text';
      }

      // Be forgiving: 'single'/'multi' require options, but if the model asked for
      // a choice without supplying any, degrade to free-text rather than failing the
      // turn. The question text usually still makes sense as an open-ended prompt.
      if ((inputType === 'single' || inputType === 'multi') && options.length === 0) {
        inputType = 'text';
      }

      const allowCustomText = !!args.allowCustomText && inputType !== 'text';
      const placeholder = args.placeholder ? String(args.placeholder) : undefined;

      const answer = await askUser({
        question,
        inputType,
        options: inputType === 'text' ? undefined : options,
        allowCustomText,
        placeholder
      });
      return { content: answer || '(no response)' };
    }
  };

  return [proposeEdit, askUserTool];
}

export type { Tool };
