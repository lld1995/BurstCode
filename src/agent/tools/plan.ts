import { Tool, ToolResult } from './types';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  id: string;
  content: string;
  status: PlanStepStatus;
}

const STATUS_VALUES: PlanStepStatus[] = ['pending', 'in_progress', 'completed'];

function normalizeStatus(value: unknown): PlanStepStatus {
  return STATUS_VALUES.includes(value as PlanStepStatus) ? (value as PlanStepStatus) : 'pending';
}

/**
 * Build the `update_plan` tool. The provided callback is invoked synchronously each
 * time the LLM updates the plan; the host (ChatViewProvider) is expected to persist
 * the new plan and forward it to the webview.
 */
export function buildPlanTool(onUpdate: (steps: PlanStep[]) => void): Tool {
  return {
    name: 'update_plan',
    // Plan publishes user-visible state in order; serialize relative to other calls.
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'update_plan',
        description:
          'Publish or revise a multi-step plan visible to the user. Use this AFTER you have gathered enough context and only when the request is non-trivial (multiple files, several edits, or a longer investigation). Always submit the FULL plan (not deltas). Mark exactly one step as "in_progress" at a time and flip steps to "completed" as you finish them. Skip this tool entirely for trivial single-edit tasks.',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Ordered list of plan steps. Replaces any previous plan.',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Stable identifier reused across updates (e.g. "1", "fix-import").'
                  },
                  content: {
                    type: 'string',
                    description: 'Short imperative description, e.g. "Refactor X to use Y".'
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed']
                  }
                },
                required: ['id', 'content', 'status']
              }
            }
          },
          required: ['steps']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const raw = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
      const steps: PlanStep[] = [];
      const seen = new Set<string>();
      for (const r of raw) {
        const id = String(r.id ?? '').trim();
        const content = String(r.content ?? '').trim();
        if (!id || !content || seen.has(id)) continue;
        seen.add(id);
        steps.push({ id, content, status: normalizeStatus(r.status) });
      }
      if (steps.length === 0) {
        return { content: 'Plan rejected: at least one step is required.', isError: true };
      }
      const inProgress = steps.filter((s) => s.status === 'in_progress').length;
      if (inProgress > 1) {
        return {
          content: 'Plan rejected: at most one step may be "in_progress" at a time.',
          isError: true
        };
      }
      onUpdate(steps);
      const summary = steps
        .map((s, i) => `${i + 1}. [${s.status}] ${s.content}`)
        .join('\n');
      return {
        content: `Plan updated (${steps.length} step${steps.length === 1 ? '' : 's'}):\n${summary}`,
        meta: { steps }
      };
    }
  };
}
