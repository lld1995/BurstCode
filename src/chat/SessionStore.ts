import * as vscode from 'vscode';
import { ChatMessage } from '../llm/OpenAIClient';
import { PlanStep } from '../agent/tools/plan';

/**
 * High-level lifecycle state of an agent session. Drives the status badge
 * rendered in the chat history list and gates whether the user can resume /
 * cancel the run from the panel.
 */
export type SessionStatus =
  | 'idle'        // never run, or run finished and we forgot the exact reason
  | 'running'     // an AgentLoop is currently driving this session
  | 'completed'   // last run finished normally (stop / tool_calls / proposed_edit_done)
  | 'stopped'     // last run was cancelled by the user / hit max iters / stuck
  | 'error';      // last run threw / surfaced an error event

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status?: SessionStatus;
}

/**
 * A rollback point captured at the start of a user prompt. The agent run
 * that follows this user message can be rolled back to this snapshot — even
 * after the user has accepted the proposed edits.
 */
export interface SessionCheckpoint {
  /** Index in `Session.messages` of the user message this checkpoint belongs to. */
  messageIndex: number;
  /** Checkpoint ref — `file:<ts>` for file-based checkpoints (current), or legacy `refs/burstcode/checkpoints/<ts>` for old git-based ones. */
  ref: string;
  /** Object name the ref points at. */
  sha: string;
  /** ms since epoch */
  createdAt: number;
  /** Short label captured at creation time (typically the user prompt). */
  label: string;
}

export interface Session extends SessionMeta {
  messages: ChatMessage[];
  plan?: PlanStep[];
  checkpoints?: SessionCheckpoint[];
}

export function isTerminalStatus(s: SessionStatus | undefined): boolean {
  return s === 'completed' || s === 'stopped' || s === 'error' || s === 'idle' || !s;
}

const KEY_INDEX = 'burstcode.sessions.index';
const KEY_SESSION_PREFIX = 'burstcode.session.';
const MAX_SESSIONS = 100;

/**
 * Persist chat sessions in workspace state. Keeps a small index Memento entry
 * (newest first) plus one entry per session keyed by id.
 */
export class SessionStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): SessionMeta[] {
    const arr = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    return arr.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.state.get<Session>(KEY_SESSION_PREFIX + id);
  }

  async save(session: Session): Promise<void> {
    const idx = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    const meta: SessionMeta = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status
    };
    const without = idx.filter((m) => m.id !== session.id);
    without.unshift(meta);
    // Trim oldest if we exceed cap.
    let trimmed = without;
    if (trimmed.length > MAX_SESSIONS) {
      const drop = trimmed.slice(MAX_SESSIONS);
      trimmed = trimmed.slice(0, MAX_SESSIONS);
      for (const m of drop) {
        await this.state.update(KEY_SESSION_PREFIX + m.id, undefined);
      }
    }
    await this.state.update(KEY_INDEX, trimmed);
    await this.state.update(KEY_SESSION_PREFIX + session.id, session);
  }

  async delete(id: string): Promise<void> {
    const idx = (this.state.get<SessionMeta[]>(KEY_INDEX) ?? []).filter((m) => m.id !== id);
    await this.state.update(KEY_INDEX, idx);
    await this.state.update(KEY_SESSION_PREFIX + id, undefined);
  }

  async clear(): Promise<void> {
    const idx = this.state.get<SessionMeta[]>(KEY_INDEX) ?? [];
    for (const m of idx) {
      await this.state.update(KEY_SESSION_PREFIX + m.id, undefined);
    }
    await this.state.update(KEY_INDEX, []);
  }
}

export function createSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function deriveTitle(text: string): string {
  const first = text.replace(/\s+/g, ' ').trim();
  if (!first) return 'New chat';
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

/** Compact rendered transcript used for replaying a saved session into the webview. */
export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool';
  text: string;
  name?: string;
  isError?: boolean;
  /** For tool entries: the parsed call arguments, so the webview can rebuild
   *  the rich diff / read / collect cards (propose_edit, write_file, read_file,
   *  collect_context) when replaying a session from history. */
  args?: unknown;
  /** For user entries: index in the original messages array. */
  messageIndex?: number;
  /** For user entries: rollback ref captured before this prompt was processed. */
  checkpointRef?: string;
}

export function buildTranscript(
  messages: ChatMessage[],
  checkpoints?: SessionCheckpoint[]
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const refByIndex = new Map<number, string>();
  for (const c of checkpoints ?? []) {
    const idx =
      messages[c.messageIndex]?.role === 'system' && messages[c.messageIndex + 1]?.role === 'user'
        ? c.messageIndex + 1
        : c.messageIndex;
    refByIndex.set(idx, c.ref);
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '';
      // Skip internal messages injected by the agent loop that were never
      // shown to the user as real input: system notes, auto-continue nudges,
      // stuck-detector corrections, length-truncation continue prompts,
      // decision-buffer feedback, and context-offload hints.
      const isInternal =
        !text ||
        text.startsWith('(System note)') ||
        text.startsWith('[auto-continue]') ||
        text.startsWith('[stuck-detector]') ||
        text.startsWith('[user-decision]') ||
        text.startsWith('[context-offload hint]') ||
        text.startsWith('Your previous response was cut off');
      if (!isInternal) {
        entries.push({
          kind: 'user',
          text,
          messageIndex: i,
          checkpointRef: refByIndex.get(i)
        });
      }
    } else if (m.role === 'assistant') {
      // Render reasoning_content (DeepSeek V4 field, or chain-of-thought
      // we extracted from <think>...</think> tags in Qwen3 / GLM / Kimi
      // output) as a separate collapsible entry that precedes the answer.
      const reasoning = (m as unknown as { reasoning_content?: unknown }).reasoning_content;
      if (typeof reasoning === 'string' && reasoning) {
        entries.push({ kind: 'reasoning', text: reasoning });
      }
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) entries.push({ kind: 'assistant', text });
      const calls =
        (m as unknown as { tool_calls?: Array<{ id?: string; function: { name: string; arguments: string } }> })
          .tool_calls ?? [];
      for (const c of calls) {
        // Preserve the parsed arguments so the webview can rebuild the rich
        // tool card (diff / read / collect) when this session is replayed from
        // history. `text` starts as a placeholder and is overwritten by the
        // matching tool-result message below.
        let parsedArgs: unknown;
        try { parsedArgs = JSON.parse(c.function.arguments); } catch { parsedArgs = undefined; }
        entries.push({
          kind: 'tool',
          name: c.function.name,
          text: '(call) ' + c.function.arguments,
          args: parsedArgs
        });
      }
    } else if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : '';
      // Attach to last tool entry if name unknown.
      const last = entries[entries.length - 1];
      if (last && last.kind === 'tool' && last.text.startsWith('(call)')) {
        // Overwrite the placeholder with the real result, but KEEP last.args /
        // last.name so rich rendering still has the call arguments.
        last.text = text;
      } else {
        entries.push({ kind: 'tool', name: 'tool', text });
      }
    }
  }
  return entries;
}
