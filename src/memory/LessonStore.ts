import * as vscode from 'vscode';

/**
 * A lesson is a short, durable note the agent learned from a user correction.
 * Lessons are tagged by scope (file path / symbol / freeform tags) so the
 * agent can be reminded of them the next time it touches the same code.
 *
 * The contract:
 *   - When the user negates / corrects something the agent did, the agent
 *     records a lesson via the `record_lesson` tool.
 *   - When the user negates the *content of an existing lesson*, the agent
 *     deletes that lesson via the `forget_lesson` tool (and may record a
 *     replacement).
 *   - Before each agent run, all lessons are injected into the system prompt
 *     so the model can consult them when a request touches a matching scope.
 */
export interface LessonScope {
  /** Workspace-relative (or absolute, normalised by the store) file path. */
  file?: string;
  /** Function / class / method / variable name. */
  symbol?: string;
  /** Freeform tags (e.g. "naming-convention", "performance"). */
  tags?: string[];
}

export interface Lesson {
  id: string;
  scope: LessonScope;
  content: string;
  createdAt: number;
  updatedAt: number;
  /**
   * "Global / always-apply" flag. Important lessons are surfaced FIRST in
   * every system prompt and never truncated, regardless of how many other
   * lessons accumulate. Use for project-wide conventions, hard rules, and
   * preferences the user explicitly told us to "always" follow.
   */
  important?: boolean;
  /** Number of times this lesson has been surfaced (currently informational). */
  hits?: number;
}

const KEY_INDEX = 'quickcode.lessons.v1';
/** Hard cap so the prompt budget stays bounded even after a long-running project. */
const MAX_LESSONS = 200;

export class LessonStore {
  constructor(private readonly state: vscode.Memento) {}

  /** All stored lessons, newest-first by `updatedAt`. */
  list(): Lesson[] {
    const arr = this.state.get<Lesson[]>(KEY_INDEX) ?? [];
    return arr.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Lesson | undefined {
    return this.list().find((l) => l.id === id);
  }

  /**
   * Persist a new lesson (or update an existing one with the same id). Returns
   * the saved entry. When `supersedes` is provided, those lesson ids are
   * removed atomically — useful when a user correction *replaces* a previous
   * lesson rather than creating an unrelated one.
   */
  async upsert(input: {
    id?: string;
    scope: LessonScope;
    content: string;
    important?: boolean;
    supersedes?: string[];
  }): Promise<Lesson> {
    const now = Date.now();
    const all = this.list();
    const supersedes = new Set(input.supersedes ?? []);
    const filtered = all.filter((l) => !supersedes.has(l.id) && l.id !== input.id);

    const id = input.id ?? this.newId();
    const existing = all.find((l) => l.id === id);
    const lesson: Lesson = {
      id,
      scope: this.normaliseScope(input.scope),
      content: input.content.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      important: input.important ?? existing?.important ?? false,
      hits: existing?.hits ?? 0
    };

    // Drop the smallest-priority entries first when over cap so newly
    // recorded important rules don't bump older important rules.
    let next = [lesson, ...filtered];
    if (next.length > MAX_LESSONS) {
      const important = next.filter((l) => l.important);
      const ordinary = next
        .filter((l) => !l.important)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const ordinaryBudget = Math.max(0, MAX_LESSONS - important.length);
      next = [...important, ...ordinary.slice(0, ordinaryBudget)];
    }
    await this.state.update(KEY_INDEX, next);
    return lesson;
  }

  /** Delete one lesson by id. Returns true when something was removed. */
  async remove(id: string): Promise<boolean> {
    const all = this.list();
    const next = all.filter((l) => l.id !== id);
    if (next.length === all.length) return false;
    await this.state.update(KEY_INDEX, next);
    return true;
  }

  async clear(): Promise<void> {
    await this.state.update(KEY_INDEX, []);
  }

  /** Increment hit counters for the given ids (best-effort, never throws). */
  async bumpHits(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const all = this.list();
    let touched = false;
    for (const l of all) {
      if (ids.includes(l.id)) {
        l.hits = (l.hits ?? 0) + 1;
        touched = true;
      }
    }
    if (touched) await this.state.update(KEY_INDEX, all);
  }

  private newId(): string {
    return `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  private normaliseScope(scope: LessonScope): LessonScope {
    const out: LessonScope = {};
    if (scope.file) out.file = normalisePath(scope.file);
    if (scope.symbol) out.symbol = scope.symbol.trim();
    if (scope.tags && scope.tags.length) {
      const cleaned = Array.from(
        new Set(
          scope.tags
            .map((t) => String(t).trim().toLowerCase())
            .filter((t) => t.length > 0 && t.length < 64)
        )
      );
      if (cleaned.length) out.tags = cleaned;
    }
    return out;
  }
}

function normalisePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed) return trimmed;
  // Try to express as workspace-relative when possible so different absolute
  // paths to the same file collapse to a single scope key.
  try {
    const uri = trimmed.startsWith('file:')
      ? vscode.Uri.parse(trimmed)
      : vscode.Uri.file(trimmed);
    const rel = vscode.workspace.asRelativePath(uri, false);
    return rel.replace(/\\/g, '/');
  } catch {
    return trimmed;
  }
}

function formatLessonLine(l: Lesson): string {
  const tags: string[] = [];
  if (l.scope.file) tags.push(`file=${l.scope.file}`);
  if (l.scope.symbol) tags.push(`symbol=${l.scope.symbol}`);
  if (l.scope.tags && l.scope.tags.length) tags.push(`tags=${l.scope.tags.join(',')}`);
  const head = tags.length ? tags.join(' ') : 'global';
  return `- [${l.id}] ${head} :: ${l.content}`;
}

/**
 * Render lessons as a compact block to embed in the system prompt.
 *
 * Important lessons (project-wide rules the user explicitly told us to always
 * follow) are emitted FIRST under a "## CRITICAL RULES" sub-heading and never
 * truncated. Scoped lessons follow under "## SCOPED LESSONS" and are
 * truncated when the budget runs out.
 */
export function renderLessonsBlock(lessons: Lesson[], maxChars = 4000): {
  text: string;
  truncated: boolean;
  shown: number;
} {
  if (lessons.length === 0) {
    return { text: '(no lessons recorded yet)', truncated: false, shown: 0 };
  }
  const important = lessons.filter((l) => l.important);
  const ordinary = lessons.filter((l) => !l.important);

  const sections: string[] = [];
  let shown = 0;
  let usedChars = 0;

  if (important.length > 0) {
    const headLine = '## CRITICAL RULES (always apply, regardless of file or scope)';
    const lines = [headLine, ...important.map(formatLessonLine)];
    const block = lines.join('\n');
    sections.push(block);
    usedChars += block.length + 2;
    shown += important.length;
  }

  let truncated = false;
  if (ordinary.length > 0) {
    const headLine =
      important.length > 0 ? '## SCOPED LESSONS' : '## LESSONS';
    const lines = [headLine];
    let blockChars = headLine.length + 1;
    let added = 0;
    for (const l of ordinary) {
      const line = formatLessonLine(l);
      if (usedChars + blockChars + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      blockChars += line.length + 1;
      added++;
    }
    if (truncated) {
      lines.push(`(... ${ordinary.length - added} more scoped lessons truncated)`);
    }
    if (added > 0 || truncated) {
      sections.push(lines.join('\n'));
      shown += added;
    }
  }

  return { text: sections.join('\n\n'), truncated, shown };
}
