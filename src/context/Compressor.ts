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
  inputBudgetRatio: 0.7,
  keepLastN: 4
};

/**
 * Layered compression strategy:
 *  1. Always keep system message + last `keepLastN` exchanges in full.
 *  2. For older tool/assistant messages, summarize their content.
 *  3. For the "context" assistant attachments embedded in tool outputs, drop low-priority items.
 */
export function compressMessages(messages: ChatMessage[], cfg: CompressorConfig): ChatMessage[] {
  const budget = Math.floor(cfg.contextWindow * cfg.inputBudgetRatio);
  let current = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
  if (current <= budget) {
    // Even when we're under budget, scrub any orphan tool/tool_calls that may
    // have leaked in from a previous interrupted run or persisted session.
    return sanitizeToolPairing(messages);
  }

  const result = [...messages];

  // Keep system + last keepLastN messages, compress others.
  const systemIdx = result.findIndex((m) => m.role === 'system');
  const tailStart = Math.max(systemIdx + 1, result.length - cfg.keepLastN * 2);

  for (let i = systemIdx + 1; i < tailStart && current > budget; i++) {
    const msg = result[i];
    if (!msg) continue;
    const original = stringifyContent(msg.content);
    const originalTokens = estimateTokens(original);
    if (originalTokens < 200) continue; // skip small ones
    const summarized = summarizeText(original, 400);
    const newTokens = estimateTokens(summarized);
    if (newTokens >= originalTokens) continue;
    result[i] = { ...msg, content: summarized } as ChatMessage;
    current -= originalTokens - newTokens;
  }

  // Last-resort: drop oldest non-system messages until under budget.
  while (current > budget) {
    const idx = result.findIndex((m, i) => i > systemIdx && i < result.length - cfg.keepLastN * 2);
    if (idx < 0) break;
    const removed = result.splice(idx, 1)[0];
    current -= estimateTokens(stringifyContent(removed.content));
  }

  // Removing/summarizing oldest messages may have orphaned a `tool` reply
  // whose owning `assistant(tool_calls)` was dropped (or vice versa). Strip
  // those orphans so the request validates against the OpenAI schema:
  // every tool message must immediately follow an assistant tool_calls.
  return sanitizeToolPairing(result);
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
