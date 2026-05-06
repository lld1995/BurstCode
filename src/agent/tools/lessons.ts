import { Tool, ToolResult } from './types';
import { Lesson, LessonScope, LessonStore } from '../../memory/LessonStore';

/**
 * Build the `record_lesson` and `forget_lesson` tools. The agent uses these
 * to persist short experiences derived from user corrections, scoped by
 * file / symbol / freeform tags.
 *
 * `onChange` is fired after every successful mutation so the host can
 * refresh any lessons UI without needing to re-read the store.
 */
export function buildLessonTools(
  store: LessonStore,
  onChange?: (lessons: Lesson[]) => void
): Tool[] {
  const recordLesson: Tool = {
    name: 'record_lesson',
    // Mutates persistent state; serialise relative to other side-effecting tools.
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'record_lesson',
        description:
          'Persist a short lesson learned from a user correction so future runs touching the same scope can avoid repeating the mistake. Call this whenever the user negates or corrects something you did (e.g. "no, that\'s wrong", "you broke X again", "don\'t use approach Y here"), OR when the user states a project-wide convention or rule you should always follow ("important rule: always X", "this project never uses Y", "记住：所有文件都要..."). Tag the lesson with the most specific scope you have evidence for: the file path being discussed, the function/class/symbol involved, and/or freeform tags. Keep `content` to ONE imperative sentence describing the rule (e.g. "Keep the cancellation token as the LAST parameter in agent tool execute()"). Set `important=true` when the user expresses the rule as project-wide / always-apply / non-negotiable — those entries are surfaced in EVERY future run and never get truncated. Use `supersedes` with the ids of stale lessons listed in <lessons_learned> when this new lesson REPLACES them.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description:
                'Workspace-relative or absolute path of the file the lesson is about. Omit for project-wide / non-file lessons.'
            },
            symbol: {
              type: 'string',
              description:
                'Function, class, method, or variable name the lesson is about. Pair with `file` when possible.'
            },
            tags: {
              type: 'array',
              description: 'Optional freeform tags (e.g. ["naming", "performance"]).',
              items: { type: 'string' }
            },
            content: {
              type: 'string',
              description:
                'One concise imperative sentence describing what to do or avoid next time. No prose, no apology.'
            },
            important: {
              type: 'boolean',
              description:
                'Mark as a project-wide / always-apply rule. Important lessons appear under "CRITICAL RULES" in every future system prompt and are never truncated. Use when the user explicitly says the rule is global / always / important / a project convention. Do NOT set on file-or-symbol-specific corrections.'
            },
            supersedes: {
              type: 'array',
              description: 'Ids of existing lessons (from <lessons_learned>) this entry replaces.',
              items: { type: 'string' }
            }
          },
          required: ['content']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const content = String(args.content ?? '').trim();
      if (!content) {
        return { content: 'record_lesson rejected: `content` is required.', isError: true };
      }
      const scope: LessonScope = {};
      if (args.file) scope.file = String(args.file);
      if (args.symbol) scope.symbol = String(args.symbol);
      if (Array.isArray(args.tags)) scope.tags = (args.tags as unknown[]).map(String);

      const supersedes = Array.isArray(args.supersedes)
        ? (args.supersedes as unknown[]).map(String).filter(Boolean)
        : undefined;

      const important = args.important === true;

      const lesson = await store.upsert({ scope, content, important, supersedes });
      onChange?.(store.list());

      const tagBits: string[] = [];
      if (lesson.important) tagBits.push('IMPORTANT');
      if (lesson.scope.file) tagBits.push(`file=${lesson.scope.file}`);
      if (lesson.scope.symbol) tagBits.push(`symbol=${lesson.scope.symbol}`);
      if (lesson.scope.tags?.length) tagBits.push(`tags=${lesson.scope.tags.join(',')}`);

      const supersededNote =
        supersedes && supersedes.length
          ? ` Replaced ${supersedes.length} prior lesson(s): ${supersedes.join(', ')}.`
          : '';
      return {
        content: `Recorded lesson ${lesson.id} (${tagBits.join(' ') || 'global'}): ${lesson.content}.${supersededNote}`,
        meta: { id: lesson.id, scope: lesson.scope, important: lesson.important, supersedes }
      };
    }
  };

  const forgetLesson: Tool = {
    name: 'forget_lesson',
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'forget_lesson',
        description:
          'Delete a previously-recorded lesson when the user explicitly negates or contradicts its content (e.g. "no, that rule is wrong now", "we changed approach, drop that note"). Pass the lesson `id` as it appears in <lessons_learned>. If a replacement rule applies, follow up with `record_lesson` (or use `supersedes` on `record_lesson` instead of calling this tool first).',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The lesson id from <lessons_learned> (e.g. "l_abc_xyz").'
            }
          },
          required: ['id']
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const id = String(args.id ?? '').trim();
      if (!id) {
        return { content: 'forget_lesson rejected: `id` is required.', isError: true };
      }
      const removed = await store.remove(id);
      if (!removed) {
        return {
          content: `No lesson with id ${id}; nothing to forget.`,
          isError: true,
          meta: { id, removed: false }
        };
      }
      onChange?.(store.list());
      return { content: `Forgot lesson ${id}.`, meta: { id, removed: true } };
    }
  };

  return [recordLesson, forgetLesson];
}
