import { encode } from 'gpt-tokenizer';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Rough fallback: 4 chars per token
    return Math.ceil(text.length / 4);
  }
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) total += estimateTokens(JSON.stringify(m.content));
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total + 2;
}
