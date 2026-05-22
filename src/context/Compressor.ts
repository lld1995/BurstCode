import { ChatMessage } from '../llm/OpenAIClient';
import { estimateMessagesTokens, estimateTokens } from '../llm/tokenizer';

export interface CompressorConfig {
  /** total context window of the model */
  contextWindow: number;
  /** ratio reserved for prompt (rest is for output) */
  inputBudgetRatio: number;
  /** always preserve the last N message exchanges in full */
  keepLastN: number;
}

export const defaultCompressorConfig: CompressorConfig = {
  contextWindow: 32768,
  inputBudgetRatio: 0.65,
  keepLastN: 3
};

/**
 * Tiered char limits for tool/assistant messages by exchange distance from the
 * current turn (one "exchange" = one assistant turn + its tool replies).
 *
 *  Zone 0 — last keepLastN exchanges         → full (no cap)
 *  Zone 1 — keepLastN+1 .. keepLastN*3       → 1200 chars
 *  Zone 2 — keepLastN*3+1 .. keepLastN*6     → 300 chars
 *  Zone 3 — older                            → 80 chars  (just the first line)
 *
 * These apply unconditionally on every compressMessages call so context stays
 * lean even when we are well under the token budget.
 */
const ZONE_CAPS = [Infinity, 1200, 300, 80] as const;

function zoneFor(exchangeDistance: number, keepLastN: number): 0 | 1 | 2 | 3 {
  if (exchangeDistance < keepLastN) return 0;
  if (exchangeDistance < keepLastN * 3) return 1;
  if (exchangeDistance < keepLastN * 6) return 2;
  return 3;
}

/**
 * Layered compression strategy:
 *  1. Always keep system message + last `keepLastN` exchanges in full (zone 0).
 *  2. Unconditionally compress older tool/assistant content by zone (distance-based).
 *  3. Budget-overflow: drop oldest non-system messages as a last resort.
 */
export function compressMessages(messages: ChatMessage[], cfg: CompressorConfig): ChatMessage[] {
  const result = [...messages];
  const systemIdx = result.findIndex((m) => m.role === 'system');

  // ── Pass 1: unconditional distance-based tiered compression ──────────────
  // Walk backwards counting "exchange" boundaries (each user message or the
  // start of an assistant+tool group increments the exchange counter).
  // tool/assistant messages in zone ≥ 1 are capped at their zone's char limit.
  // Old reasoning_content (chain-of-thought from thinking models) is also
  // stripped — replayed thinking is dead weight; the model only needs the
  // CURRENT turn's reasoning to continue. We replace with '' instead of
  // deleting because DashScope-thinking strictly requires the field to exist.
  let exchangeDistance = 0;
  for (let i = result.length - 1; i > systemIdx; i--) {
    const m = result[i];
    if (m.role === 'user') {
      exchangeDistance++;
      continue;
    }
    if (m.role === 'system') continue;
    // assistant or tool message
    const zone = zoneFor(exchangeDistance, cfg.keepLastN);

    // Strip old reasoning_content + truncate tool_calls.arguments from any
    // assistant message past zone 0. Recent thinking and recent tool args
    // belong in zone 0 (full). Older ones are historical clutter — the
    // function NAME is enough to remind the model "I called grep_search 8
    // turns ago", the verbose args body is dead weight.
    if (zone > 0 && m.role === 'assistant') {
      type Mut = ChatMessage & {
        reasoning_content?: unknown;
        tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      };
      const am = m as Mut;
      let mutated: Mut | null = null;
      if (typeof am.reasoning_content === 'string' && am.reasoning_content.length > 0) {
        mutated = { ...am, reasoning_content: '' };
      }
      if (am.tool_calls && am.tool_calls.length > 0) {
        const argsCap = ZONE_CAPS[zone];
        const trimmed = am.tool_calls.map((tc) => {
          const argStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
          if (argStr.length <= argsCap) return tc;
          // Keep arguments as valid JSON to satisfy strict server validators.
          const placeholder = JSON.stringify({ _truncated: `${argStr.length} chars` });
          return { ...tc, function: { ...tc.function, arguments: placeholder } };
        });
        const anyChanged = trimmed.some((tc, idx) => tc !== am.tool_calls![idx]);
        if (anyChanged) {
          mutated = { ...(mutated ?? am), tool_calls: trimmed };
        }
      }
      if (mutated) {
        result[i] = mutated as unknown as ChatMessage;
      }
    }

    if (zone === 0) continue;
    const cap = ZONE_CAPS[zone];
    const msg = result[i]; // may have been rewritten by reasoning strip above
    const original = stringifyContent(msg.content);
    if (original.length <= cap) continue;
    const summarized = summarizeText(original, cap);
    result[i] = { ...msg, content: summarized } as ChatMessage;
  }

  // ── Pass 2: budget-overflow drop (last resort) ────────────────────────────
  const budget = Math.floor(cfg.contextWindow * cfg.inputBudgetRatio);
  let current = estimateMessagesTokens(result as Array<{ role: string; content: unknown }>);

  // Drop oldest non-system, non-user, non-protected messages until under budget.
  // User messages must never be dropped — they are the ground truth of the
  // conversation and their absence causes history to render without the prompts.
  const protected_ = result.length - cfg.keepLastN * 2;
  while (current > budget) {
    const idx = result.findIndex((m, i) => i > systemIdx && i < protected_ && m.role !== 'user');
    if (idx < 0) break;
    const removed = result.splice(idx, 1)[0];
    current -= estimateTokens(stringifyContent(removed.content));
  }

  // Removing/summarizing oldest messages may have orphaned a `tool` reply
  // whose owning `assistant(tool_calls)` was dropped (or vice versa). Strip
  // those orphans so the request validates against the OpenAI schema.
  return sanitizeToolPairing(result);
}

/**
 * Normalize a raw tool result string before storing it in the messages array.
 * Applies tool-type-specific reductions so the stored content is already lean
 * before the compressor ever sees it.
 */
export function normalizeToolResult(toolName: string, content: string): string {
  // Nothing to compress
  if (content.length < 200) return content;

  // grep_search: strip matched file paths that are purely informational after
  // the model has already seen them; keep only the first 60 match lines.
  if (toolName === 'grep_search') {
    const lines = content.split('\n');
    if (lines.length > 62) {
      const header = lines[0];
      const kept = lines.slice(1, 61);
      return `${header}\n${kept.join('\n')}\n...[${lines.length - 61} more lines omitted]`;
    }
    return content;
  }

  // read_file: cap at 4000 chars (tighter than AgentLoop's 6000 global cap)
  if (toolName === 'read_file') {
    if (content.length > 4000) {
      return content.slice(0, 4000) + `\n...[truncated ${content.length - 4000} chars]`;
    }
    return content;
  }

  // list_dir / workspace_outline: cap at 1500 chars
  if (toolName === 'list_dir' || toolName === 'workspace_outline') {
    if (content.length > 1500) {
      return content.slice(0, 1500) + `\n...[truncated]`;
    }
    return content;
  }

  return content;
}

/**
 * Ensure every `role: 'tool'` message references a `tool_call_id` declared on
 * a *preceding* assistant `tool_calls`, and that every assistant `tool_calls`
 * entry has a matching tool reply later in the conversation. Anything that
 * cannot be paired up is dropped (or stripped from the assistant message),
 * because the OpenAI Chat Completions API rejects the request otherwise:
 *   400 — Messages with role 'tool' must be a response to a preceding
 *         message with 'tool_calls'.
 */
export function sanitizeToolPairing(messages: ChatMessage[]): ChatMessage[] {
  type AssistantWithCalls = ChatMessage & {
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  };

  // Pass 1: collect ids of tool messages that actually appear after each
  // assistant tool_calls block (so we can prune unanswered tool_calls).
  const answeredByAssistantIdx = new Map<number, Set<string>>();
  let lastAssistantIdx = -1;
  let openIds: Set<string> | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const calls = (m as AssistantWithCalls).tool_calls ?? [];
      if (calls.length > 0) {
        lastAssistantIdx = i;
        openIds = new Set(calls.map((c) => c.id));
        answeredByAssistantIdx.set(i, new Set());
      } else {
        // A plain assistant message closes the previous tool-call window.
        lastAssistantIdx = -1;
        openIds = null;
      }
    } else if (m.role === 'tool') {
      const id = (m as ChatMessage & { tool_call_id?: string }).tool_call_id;
      if (openIds && id && openIds.has(id)) {
        answeredByAssistantIdx.get(lastAssistantIdx)?.add(id);
      }
    } else if (m.role === 'user' || m.role === 'system') {
      // user/system also close the window.
      lastAssistantIdx = -1;
      openIds = null;
    }
  }

  // Pass 2: rebuild the message list, dropping orphans.
  const out: ChatMessage[] = [];
  let activeIds: Set<string> | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const calls = (m as AssistantWithCalls).tool_calls;
      if (calls && calls.length > 0) {
        const answered = answeredByAssistantIdx.get(i) ?? new Set<string>();
        const kept = calls.filter((c) => answered.has(c.id));
        if (kept.length === 0) {
          // No tool reply ever arrived — strip tool_calls so the assistant
          // message becomes a plain text turn (or skip it if also empty).
          const rest = { ...(m as AssistantWithCalls) };
          delete rest.tool_calls;
          if (rest.content || (typeof rest.content === 'string' && rest.content.length > 0)) {
            out.push(rest as ChatMessage);
          }
          activeIds = null;
        } else {
          out.push({ ...(m as AssistantWithCalls), tool_calls: kept } as ChatMessage);
          activeIds = new Set(kept.map((c) => c.id));
        }
      } else {
        out.push(m);
        activeIds = null;
      }
    } else if (m.role === 'tool') {
      const id = (m as ChatMessage & { tool_call_id?: string }).tool_call_id;
      if (activeIds && id && activeIds.has(id)) {
        out.push(m);
      }
      // else: orphan tool reply, drop it.
    } else {
      out.push(m);
      if (m.role === 'user' || m.role === 'system') activeIds = null;
    }
  }
  return out;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

/**
 * Heuristic summarizer: keeps the first N chars + first/last lines of code blocks.
 * Designed to run instantly without an LLM round-trip.
 */
export function summarizeText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  if (codeBlocks.length > 0) {
    const head = text.slice(0, Math.min(maxChars / 2, 600));
    const codeHints = codeBlocks
      .map((b) => {
        const lines = b.split('\n');
        if (lines.length <= 6) return b;
        return [lines[0], lines[1], '... (truncated) ...', lines[lines.length - 2], lines[lines.length - 1]].join('\n');
      })
      .join('\n');
    return `${head}\n\n[summary] truncated; key code excerpts:\n${codeHints}`.slice(0, maxChars);
  }
  return text.slice(0, maxChars - 20) + '\n... [truncated]';
}
