import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';
import { HunkApplier, ProposedEditFile } from '../../edits/HunkApplier';

export function buildEditTools(applier: HunkApplier, askUser: (q: string, options?: string[]) => Promise<string>): Tool[] {
  const proposeEdit: Tool = {
    name: 'propose_edit',
    // Mutates HunkApplier state and may open a diff editor; serialize.
    parallelSafe: false,
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
        description: 'Ask the user a clarifying question when requirements are ambiguous.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } }
          },
          required: ['question']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const question = String(args.question);
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : undefined;
      const answer = await askUser(question, options);
      return { content: answer || '(no response)' };
    }
  };

  return [proposeEdit, askUserTool];
}

export type { Tool };
