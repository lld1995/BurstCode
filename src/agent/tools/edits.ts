import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';
import { HunkApplier, ProposedEditFile } from '../../edits/HunkApplier';

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
          'Queue a set of line-based edits across one or more files for user review. NON-BLOCKING: returns immediately. You may call propose_edit multiple times within a turn (and across turns) to keep refining the queued change set; later hunks that overlap earlier pending hunks replace them (last-write-wins). The user accepts or rejects the queued edits at their leisure via a chat banner or per-hunk CodeLenses. Use 1-indexed inclusive [startLine, endLine] referring to the CURRENT on-disk file content. To INSERT without replacing, set startLine=endLine+1 and end newText with a newline. To CREATE A NEW FILE, set path to the new file path (parent directories will be auto-created), startLine=1, endLine=0, and put the full file contents in newText. Do NOT bail out and stuff the new code into an unrelated existing file just because the file does not exist yet \u2014 propose_edit handles file creation natively.',
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
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  newText: { type: 'string' }
                },
                required: ['path', 'startLine', 'endLine', 'newText']
              }
            }
          },
          required: ['summary', 'edits']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const summary = String(args.summary ?? '');
      const rawEdits = Array.isArray(args.edits) ? args.edits : [];
      const grouped = new Map<string, ProposedEditFile>();
      for (const e of rawEdits as Array<Record<string, unknown>>) {
        const path = String(e.path);
        const startLine = Number(e.startLine);
        const endLine = Number(e.endLine);
        const newText = String(e.newText ?? '');
        if (!path || !Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
        const entry = grouped.get(path) ?? { path, hunks: [] };
        entry.hunks.push({ startLine, endLine, newText });
        grouped.set(path, entry);
      }
      const files = Array.from(grouped.values());
      if (files.length === 0) return { content: 'no edits provided', isError: true };
      await applier.proposeEdits(files, summary);
      return {
        content: `Queued edits for ${files.length} file(s) — pending user review (non-blocking). You may call propose_edit again to add or replace hunks, or move on to the next step.`,
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
