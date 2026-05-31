import * as vscode from 'vscode';
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

function pickLooseNumberField(text: string, key: string): number | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function parseLooseStringifiedEdits(text: string): unknown[] {
  const edits: unknown[] = [];
  let pos = 0;
  while (pos < text.length) {
    const objectStart = text.indexOf('{', pos);
    if (objectStart < 0) break;
    const rest = text.slice(objectStart);
    const pathPicked = pickLooseStringField(rest, [
      'path',
      'file',
      'filePath',
      'filename',
      'fileName',
      'target',
      'targetFile',
      'uri'
    ]);
    const newTextPicked = pickLooseStringField(rest, [
      'newText',
      'new_text',
      'replacement',
      'code',
      'content',
      'text'
    ]);
    if (!pathPicked || !newTextPicked) {
      pos = objectStart + 1;
      continue;
    }
    const segment = rest.slice(0, Math.max(pathPicked.end, newTextPicked.end) + 1);
    edits.push({
      [pathPicked.key]: pathPicked.value,
      newText: newTextPicked.value,
      ...(pickLooseNumberField(segment, 'startLine') !== undefined
        ? { startLine: pickLooseNumberField(segment, 'startLine') }
        : {}),
      ...(pickLooseNumberField(segment, 'endLine') !== undefined
        ? { endLine: pickLooseNumberField(segment, 'endLine') }
        : {}),
      ...(pickLooseStringField(segment, ['oldText', 'old_text', 'original', 'search'])?.value !== undefined
        ? { oldText: pickLooseStringField(segment, ['oldText', 'old_text', 'original', 'search'])?.value }
        : {})
    });
    pos = objectStart + newTextPicked.end + 1;
  }
  return edits;
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

export function buildEditTools(applier: HunkApplier, askUser: AskUserFn): Tool[] {
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
          "Apply edits to one or more files IMMEDIATELY — they land on disk as soon as this tool returns and the user can compile / run with them right away. The changes are ALSO staged for user review; Accept simply marks them as finalized, while Reject rolls the affected hunks back to the original content. Use this for modifications to the user's existing source files. For agent-generated scripts or temp files you'll execute immediately, use write_file instead.\n\n" +
          "RECOMMENDED FORM (anchor-based, robust to line drift): supply 'oldText' = the EXACT contiguous lines you want to replace (whitespace-exact, full lines). 'newText' is what they become. The applier locates oldText in the file's current view and rewrites the line range for you, so stale line numbers no longer corrupt edits. If oldText appears multiple times, set 'startLine' to the 1-indexed line where the intended match starts as a tie-breaker, OR add more context lines to oldText to make it unique.\n\n" +
          "FALLBACK FORM (line-range, used when oldText is omitted): supply 1-indexed inclusive [startLine, endLine] referring to the file AS YOU LAST SAW IT via read_file. When the file has pending edits, read_file returns the post-edit preview WITH a `pending hunks` map at the bottom — copy those line numbers as-is. To INSERT without replacing in this form, set startLine = endLine + 1 and end newText with a newline.\n\n" +
          "CREATING A NEW FILE: set path to the new file path (parent dirs auto-created), startLine=1, endLine=0, omit oldText, and put the full file contents in newText. Do NOT stuff new code into an unrelated existing file just because the target doesn't exist yet — propose_edit handles file creation natively.\n\n" +
          "You may call propose_edit multiple times within a turn (and across turns) to refine the queued change set. Later hunks that fully contain earlier pending hunks replace them (last-write-wins); partially-overlapping hunks are REJECTED with a clear error so you can retarget. The user accepts/rejects via a chat banner or per-hunk CodeLenses; when they finish a file, you'll receive a [user-decision] notice — re-read that file before any follow-up propose_edit on it.",
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One-paragraph human summary.' },
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
          required: ['summary', 'edits']
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
            rawEdits = parseLooseStringifiedEdits(quoteRepaired ?? afterControl);
            stringifiedEditsParseFailed = rawEdits.length === 0;
          }
        }
      } else {
        rawEdits = [];
      }
      // Top-level path fallback: when the model emits {summary, path, edits:
      // [{oldText, newText}, ...]} (a single-file convenience form it
      // sometimes invents), propagate that path to every hunk that lacks
      // its own. Cheap to support; expensive to debug when missing.
      const argsRecord = (args ?? {}) as Record<string, unknown>;
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
        const hasOldText = oldTextPicked !== undefined;
        const startLineRaw = e.startLine === undefined ? NaN : Number(e.startLine);
        const endLineRaw = e.endLine === undefined ? NaN : Number(e.endLine);
        if (!path) {
          const presentKeys = Object.keys(e);
          skipReasons.push(
            `edits[${i}]: missing 'path' — keys present: [${presentKeys.join(', ') || '(none)'}]`
          );
          continue;
        }
        // oldText form: line numbers optional (used as hint).
        // Line-range form: both startLine and endLine required.
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
      try {
        await applier.proposeEdits(files, summary);
      } catch (err) {
        // proposeEdits throws on overlap-rejection (new hunks that clash with
        // already-accepted regions, partially overlap pending hunks, or
        // overlap each other within the same call) and on oldText resolution
        // failure. Per-file errors are aggregated; files that succeeded ARE
        // already queued and visible in the chat banner — only the named
        // files need re-targeting.
        const message = err instanceof Error ? err.message : String(err);
        return {
          content:
            `propose_edit error(s): ${message}\n` +
            `ACTION REQUIRED for the files named in the error above ONLY: re-read each with read_file ` +
            `(line numbers may be stale) and re-issue propose_edit with corrected oldText / non-overlapping ranges. ` +
            `Prefer the oldText form so line drift no longer matters.\n` +
            `Any files NOT named in the error were queued successfully — do NOT re-submit those; they are already staged and do not need further action from you.`,
          isError: true
        };
      }
      const aliasNotes: string[] = [];
      if (synthesizedFromTopLevel) {
        aliasNotes.push(
          "edit fields (path/newText/oldText) were sent at the TOP LEVEL with no 'edits' array; wrapped them into edits:[{...}] for you"
        );
      }
      if (usedAlias) {
        aliasNotes.push(`top-level field 'edits' was sent as '${usedAlias}'`);
      }
      if (aliasedPathKey) {
        aliasNotes.push(`per-edit field 'path' was sent as '${aliasedPathKey}'`);
      }
      const aliasNote = aliasNotes.length
        ? `\nNote: ${aliasNotes.join('; ')}. Accepted this time — please use the canonical field names ('edits', 'path') on subsequent calls.`
        : '';
      const filePaths = files.map((f) => f.path).join(', ');
      return {
        content: `Queued edits for ${files.length} file(s): ${filePaths} — pending user review (non-blocking). You may call propose_edit again to add or replace hunks, or move on to the next step.${aliasNote}`,
        meta: { files: files.map((f) => f.path), summary }
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

      if ((inputType === 'single' || inputType === 'multi') && options.length === 0) {
        return {
          content: `ask_user inputType='${inputType}' requires at least one option. Provide options or use inputType='text'.`,
          isError: true
        };
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
