import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../../llm/OpenAIClient';
import { compressMessages, defaultCompressorConfig } from '../../context/Compressor';
import { estimateMessagesTokens } from '../../llm/tokenizer';
import { Tool, ToolResult } from './types';

/**
 * Build the per-run aggressive compressor config for topic-switch compression.
 * keepLastN=1: preserves the most recent user message + current assistant turn.
 * inputBudgetRatio=0.3: frees ~70% of the token budget post-compression.
 */
function topicSwitchConfig(contextWindow: number) {
  return { ...defaultCompressorConfig, contextWindow, keepLastN: 1, inputBudgetRatio: 0.3 };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Build the `compress_context` and `save_topic_doc` context-management tools.
 *
 * @param messages - The live session messages array (mutated in place by compress_context).
 * @param workspaceRoot - Absolute path to the workspace root (used by save_topic_doc).
 * @param contextWindow - Model context window size; used by compress_context for budget math.
 * @param onCompressed - Optional callback fired after compress_context splices messages.
 *   The caller should use this to clear any stale checkpoint indices (messageIndex values
 *   become invalid once messages are spliced).
 */
export function buildContextTools(
  messages: ChatMessage[],
  workspaceRoot: string,
  contextWindow = defaultCompressorConfig.contextWindow,
  onCompressed?: () => void
): Tool[] {
  const compressContext: Tool = {
    name: 'compress_context',
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'compress_context',
        description:
          'Aggressively compress the current session context when you have determined that the ' +
          'user\'s new request is COMPLETELY UNRELATED to everything this session has worked on so ' +
          'far — different module, different bug, different feature, with no shared files or symbols. ' +
          'This frees token budget so the new topic can proceed cleanly. ' +
          'ALWAYS call save_topic_doc FIRST if the current topic produced useful findings worth keeping. ' +
          'DO NOT call this when the user is still investigating the same issue from a different angle, ' +
          'or doing any kind of follow-up or refinement on the same area of code.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description:
                'One sentence explaining why you concluded this is a complete topic switch ' +
                '(e.g. "User switched from debugging AuthService to adding a new CSV export feature — ' +
                'no shared files or symbols with prior work").'
            }
          },
          required: ['reason']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const reason = String(args.reason ?? '(no reason given)');
      const before = estimateMessagesTokens(
        messages as Array<{ role: string; content: unknown }>
      );
      const compacted = compressMessages(messages, topicSwitchConfig(contextWindow));
      messages.splice(0, messages.length, ...compacted);
      const after = estimateMessagesTokens(
        messages as Array<{ role: string; content: unknown }>
      );
      onCompressed?.();
      return {
        content:
          `Context compressed for topic switch: ${before} → ${after} tokens freed ~${before - after}. ` +
          `Reason: ${reason}. ` +
          `The session now retains only the most recent exchange in full; older history is summarised.`
      };
    }
  };

  const saveTopicDoc: Tool = {
    name: 'save_topic_doc',
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'save_topic_doc',
        description:
          'Save a concise investigation summary to .burstcode/topics/ so future sessions can ' +
          'read it instead of re-collecting the same code. Call this when you have completed (or ' +
          'are wrapping up) a significant investigation — found a root cause, understood a module, ' +
          'solved a bug — AND the findings would help avoid re-reading the same files next time. ' +
          'Skip for trivial 1-turn Q&A that adds no reusable knowledge. ' +
          'Write precise file paths, symbol names, and one-sentence learnings — not vague summaries.',
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short topic title (max ~60 chars), e.g. "AgentLoop stuck-detector fix".'
            },
            problem: {
              type: 'string',
              description: 'One paragraph: what the user was trying to do / what the problem was.'
            },
            files_touched: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Workspace-relative paths of the key files examined or modified (most important first).'
            },
            findings: {
              type: 'string',
              description:
                'Key discoveries: relevant classes, functions, line ranges, patterns found. ' +
                'Be specific — include symbol names and approximate line numbers where helpful.'
            },
            solution: {
              type: 'string',
              description: 'What was done or concluded (omit if investigation is ongoing / inconclusive).'
            },
            learnings: {
              type: 'string',
              description:
                'Reusable one-liners that would let a future session skip re-reading code, ' +
                'e.g. "compress_context uses keepLastN zones defined in Compressor.ts:33".'
            }
          },
          required: ['title', 'problem', 'findings']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const title = String(args.title ?? 'untitled');
      const problem = String(args.problem ?? '');
      const filesTouched = Array.isArray(args.files_touched)
        ? (args.files_touched as unknown[]).map(String)
        : [];
      const findings = String(args.findings ?? '');
      const solution = args.solution ? String(args.solution) : undefined;
      const learnings = args.learnings ? String(args.learnings) : undefined;

      const slug = slugify(title);
      const ts = Date.now();
      const isoDate = new Date(ts).toISOString();
      const fileName = `${slug}-${ts}.md`;
      const topicsDir = path.join(workspaceRoot, '.burstcode', 'topics');
      const filePath = path.join(topicsDir, fileName);

      const lines: string[] = [
        '---',
        `date: ${isoDate}`,
        `topic: ${title}`
      ];
      if (filesTouched.length > 0) {
        lines.push(`files: ${filesTouched.join(', ')}`);
      }
      lines.push('---', '');

      lines.push('## Problem', problem, '');
      if (filesTouched.length > 0) {
        lines.push('## Key Files', filesTouched.map((f) => `- ${f}`).join('\n'), '');
      }
      lines.push('## Findings', findings, '');
      if (solution) {
        lines.push('## Solution', solution, '');
      }
      if (learnings) {
        lines.push('## Reusable Learnings', learnings, '');
      }

      const content = lines.join('\n');

      try {
        await fs.promises.mkdir(topicsDir, { recursive: true });
        await fs.promises.writeFile(filePath, content, 'utf-8');
        return {
          content: `Topic doc saved: .burstcode/topics/${fileName} (${content.length} chars).`
        };
      } catch (err) {
        return {
          content: `Failed to save topic doc: ${String(err)}`,
          isError: true
        };
      }
    }
  };

  return [compressContext, saveTopicDoc];
}
