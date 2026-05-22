import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';
import { HunkApplier, ProposedEditFile } from '../../edits/HunkApplier';

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
          "Queue edits across one or more files for user review. NON-BLOCKING: returns immediately — edits are NOT written to disk until the user accepts them. Use for modifications to the user's existing source files. For agent-generated scripts or temp files you'll execute immediately, use write_file instead.\n\n" +
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
      const rawEdits = Array.isArray(rawEditsCandidate) ? rawEditsCandidate : [];
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
            `Files NOT named above were queued successfully and remain pending in the banner. ` +
            `For each named file, re-read it with read_file (the line numbers you saw earlier may be stale) ` +
            `and re-issue propose_edit with corrected oldText / non-overlapping ranges. ` +
            `Prefer the oldText form so line drift no longer matters.`,
          isError: true
        };
      }
      const aliasNotes: string[] = [];
      if (usedAlias) {
        aliasNotes.push(`top-level field 'edits' was sent as '${usedAlias}'`);
      }
      if (aliasedPathKey) {
        aliasNotes.push(`per-edit field 'path' was sent as '${aliasedPathKey}'`);
      }
      const aliasNote = aliasNotes.length
        ? `\nNote: ${aliasNotes.join('; ')}. Accepted this time — please use the canonical field names ('edits', 'path') on subsequent calls.`
        : '';
      return {
        content: `Queued edits for ${files.length} file(s) — pending user review (non-blocking). You may call propose_edit again to add or replace hunks, or move on to the next step.${aliasNote}`,
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
