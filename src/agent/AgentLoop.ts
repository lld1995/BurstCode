import * as vscode from 'vscode';
import { ChatMessage, OpenAIClient, ToolDef } from '../llm/OpenAIClient';
import { Tool, ToolResult } from './tools/types';
import { FALLBACK_SYSTEM_PROMPT } from './prompts';
import { compressMessages, defaultCompressorConfig } from '../context/Compressor';
import { estimateMessagesTokens } from '../llm/tokenizer';
import { Logger } from '../util/Logger';
import { HunkApplier } from '../edits/HunkApplier';
import { AskUserFn } from './tools/edits';

export interface AgentEvent {
  type:
    | 'assistant-delta'
    | 'assistant-message'
    | 'reasoning-delta'
    | 'tool-call-start'
    | 'tool-call-end'
    | 'iteration-start'
    | 'auto-continue'
    | 'context-usage'
    | 'context-compressed'
    | 'stuck-detected'
    | 'done'
    | 'error';
  payload?: unknown;
}

/** Auto-compress when usage exceeds this fraction of the context window. */
const AUTO_COMPRESS_TRIGGER_RATIO = 0.9;
/** Target post-compression budget (input ratio) so we free at least half of the in-use space. */
const AUTO_COMPRESS_TARGET_RATIO = 0.4;

/**
 * After how many CONSECUTIVE turns of identical tool-call batches we consider
 * the agent stuck. The 1st repeat triggers an automatic self-correction nudge;
 * the 2nd repeat (i.e. 3 identical turns in a row) escalates to askUser.
 */
const DEFAULT_MAX_STUCK_REPEATS = 2;

/**
 * Canonicalize a tool-call batch into a stable string so two turns that
 * dispatch the same set of (name, args) pairs hash equal even if the model
 * happens to emit them in a different order, or with semantically-equivalent
 * but textually-different JSON (e.g. key reordering).
 */
function toolCallSetSignature(
  calls: Array<{ name: string; arguments: string }>
): string {
  const items = calls.map((c) => {
    let parsed: unknown = c.arguments;
    try {
      parsed = c.arguments ? JSON.parse(c.arguments) : {};
    } catch {
      // Leave the raw string in place; non-JSON args still hash deterministically.
    }
    return JSON.stringify([c.name, canonicalize(parsed)]);
  });
  items.sort();
  return items.join('|');
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalize(obj[k]);
    return out;
  }
  return v;
}

function describeCalls(calls: Array<{ name: string; arguments: string }>): string {
  return calls.map((c) => c.name).join(', ');
}

export interface AgentOptions {
  contextWindow: number;
  maxIterations: number;
  requireConfirmBeforeEdit: boolean;
  /** Auto-continue when the LLM stops mid-turn because of output token limit. */
  autoContinueOnLength: boolean;
  /** Cap on consecutive auto-continues (resets whenever the model makes progress via a tool call). */
  maxAutoContinues: number;
  /**
   * System prompt for this run. Built freshly per user request by the host so
   * it can embed an up-to-date workspace outline. When omitted the agent
   * falls back to the static prompt used in tests / headless environments.
   */
  systemPrompt?: string;
  /**
   * Callback used to escalate to the user when the agent appears stuck (i.e.
   * the model keeps issuing identical tool-call batches). When omitted the
   * loop just terminates with reason 'stuck' instead of asking.
   */
  askUser?: AskUserFn;
  /**
   * Number of CONSECUTIVE identical tool-call batches that must be observed
   * before escalating to askUser. The 1st repeat always triggers an automatic
   * self-correction nudge; askUser fires once `consecutiveRepeats >= this`.
   */
  maxStuckRepeats?: number;
}

export class AgentLoop {
  private readonly toolMap: Map<string, Tool>;

  constructor(
    private readonly client: OpenAIClient,
    private readonly tools: Tool[],
    private readonly applier: HunkApplier,
    private readonly logger: Logger,
    private readonly options: AgentOptions
  ) {
    this.toolMap = new Map(tools.map((t) => [t.name, t]));
  }

  toolDefs(): ToolDef[] {
    return this.tools.map((t) => t.schema);
  }

  /**
   * Drive the multi-turn loop.
   * `messages` is mutated in-place (used as conversation memory across calls).
   */
  async *run(
    messages: ChatMessage[],
    cancellation: vscode.CancellationToken
  ): AsyncGenerator<AgentEvent, void, void> {
    // Always materialize the freshest system prompt at the head of the
    // conversation. For new sessions this seeds the system message; for
    // resumed sessions it replaces a stale prompt (e.g. previous outline
    // snapshot) so the model sees the current workspace layout.
    const systemContent = this.options.systemPrompt ?? FALLBACK_SYSTEM_PROMPT;
    const sysIdx = messages.findIndex((m) => m.role === 'system');
    if (sysIdx === -1) {
      messages.unshift({ role: 'system', content: systemContent });
    } else {
      messages[sysIdx] = { role: 'system', content: systemContent };
    }

    let consecutiveAutoContinues = 0;

    // Stuck-detection state: signature of the previous turn's tool-call batch
    // and the number of consecutive turns we've seen the SAME signature. Reset
    // whenever the model emits a different batch (i.e. makes progress) or the
    // user resolves an askUser escalation.
    let lastToolCallSignature: string | null = null;
    let consecutiveRepeats = 0;
    const maxStuckRepeats = this.options.maxStuckRepeats ?? DEFAULT_MAX_STUCK_REPEATS;

    for (let iter = 0; iter < this.options.maxIterations; iter++) {
      if (cancellation.isCancellationRequested) {
        yield { type: 'done', payload: { reason: 'cancelled' } };
        return;
      }
      yield { type: 'iteration-start', payload: { iter } };

      // Measure persistent context usage and auto-compress in place when we
      // cross the high-water mark. Compressing the persistent `messages`
      // array (rather than only the per-turn snapshot below) is what frees
      // memory across future turns and keeps the UI gauge in sync with the
      // session that gets persisted to disk.
      const ctxMax = this.options.contextWindow;
      let usedTokens = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
      if (ctxMax > 0 && usedTokens / ctxMax > AUTO_COMPRESS_TRIGGER_RATIO) {
        const before = usedTokens;
        const compacted = compressMessages(messages, {
          ...defaultCompressorConfig,
          contextWindow: ctxMax,
          inputBudgetRatio: AUTO_COMPRESS_TARGET_RATIO
        });
        // Replace contents in place so callers holding the same array
        // reference (the chat session store) see the new transcript.
        messages.splice(0, messages.length, ...compacted);
        usedTokens = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
        this.logger.info(
          `Auto-compressed context: ${before} → ${usedTokens} tokens (${ctxMax} window).`
        );
        yield {
          type: 'context-compressed',
          payload: { before, after: usedTokens, max: ctxMax }
        };
      }
      yield {
        type: 'context-usage',
        payload: { used: usedTokens, max: ctxMax }
      };

      const compressed = compressMessages(messages, {
        ...defaultCompressorConfig,
        contextWindow: this.options.contextWindow
      });

      let assistantText = '';
      let reasoningText = '';
      const toolCallAccumulator = new Map<
        number,
        { id?: string; name: string; arguments: string }
      >();
      let finishReason: string | undefined;

      try {
        for await (const chunk of this.client.streamChat(compressed, this.toolDefs(), cancellation)) {
          if (chunk.contentDelta) {
            assistantText += chunk.contentDelta;
            yield { type: 'assistant-delta', payload: chunk.contentDelta };
          }
          if (chunk.reasoningDelta) {
            reasoningText += chunk.reasoningDelta;
            yield { type: 'reasoning-delta', payload: chunk.reasoningDelta };
          }
          if (chunk.toolCallDelta) {
            const idx = chunk.toolCallDelta.index;
            const entry =
              toolCallAccumulator.get(idx) ?? { id: undefined, name: '', arguments: '' };
            if (chunk.toolCallDelta.id) entry.id = chunk.toolCallDelta.id;
            if (chunk.toolCallDelta.name) entry.name = chunk.toolCallDelta.name;
            if (chunk.toolCallDelta.argumentsDelta) entry.arguments += chunk.toolCallDelta.argumentsDelta;
            toolCallAccumulator.set(idx, entry);
          }
          if (chunk.finishReason) finishReason = chunk.finishReason;
        }
      } catch (err) {
        this.logger.error('LLM stream error', String(err));
        yield { type: 'error', payload: String(err) };
        return;
      }

      const toolCalls = Array.from(toolCallAccumulator.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.name);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantText || null,
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc, i) => ({
                id: tc.id ?? `call_${Date.now()}_${i}`,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments || '{}' }
              }))
            }
          : {})
      } as ChatMessage;
      messages.push(assistantMsg);
      yield { type: 'assistant-message', payload: { text: assistantText, toolCalls: toolCalls.length } };

      if (toolCalls.length === 0) {
        const truncated = finishReason === 'length';
        if (
          truncated &&
          this.options.autoContinueOnLength &&
          consecutiveAutoContinues < this.options.maxAutoContinues
        ) {
          consecutiveAutoContinues++;
          this.logger.info(
            `Output truncated (finish_reason=length); auto-continuing ${consecutiveAutoContinues}/${this.options.maxAutoContinues}`
          );
          messages.push({
            role: 'user',
            content:
              'Your previous response was cut off due to the output token limit. Continue exactly from where you left off without repeating any text already produced. If you were about to call a tool, emit the tool call now.'
          });
          yield {
            type: 'auto-continue',
            payload: { count: consecutiveAutoContinues, max: this.options.maxAutoContinues }
          };
          continue;
        }
        yield { type: 'done', payload: { reason: finishReason ?? 'stop' } };
        return;
      }

      // Tool calls were emitted: making real progress, reset the auto-continue budget.
      consecutiveAutoContinues = 0;

      // Iterate the same filtered `toolCalls` array we used to build
      // assistantMsg.tool_calls so the tool_call_id we attach to each tool
      // reply ALWAYS matches an id on the preceding assistant message. Using
      // the raw accumulator's Map index here would desync whenever an unnamed
      // tool-call delta was filtered out earlier, producing orphan tool
      // messages that the OpenAI API rejects with HTTP 400.
      const finalCalls =
        (assistantMsg as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> })
          .tool_calls ?? [];

      // Resolve each tool-call entry up front (id, parsed args, tool ref).
      // Filtering happens here too: an entry without a name is dropped both
      // from execution AND from the message-pushing pass below, so indices
      // stay aligned with finalCalls.
      interface PreparedCall {
        index: number;
        name: string;
        callId: string;
        parsed: Record<string, unknown>;
        tool: Tool | undefined;
      }
      const prepared: PreparedCall[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!tc.name) continue;
        const callId = finalCalls[i]?.id ?? `call_${Date.now()}_${i}`;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch (err) {
          this.logger.warn('Tool args parse failed', tc.name, tc.arguments);
        }
        prepared.push({ index: i, name: tc.name, callId, parsed, tool: this.toolMap.get(tc.name) });
      }

      // Emit tool-call-start events in original order so the chat panel
      // renders a stable left-to-right tree, even when we run them in
      // parallel below.
      for (const c of prepared) {
        yield { type: 'tool-call-start', payload: { name: c.name, args: c.parsed, id: c.callId } };
      }

      const executeOne = async (c: PreparedCall): Promise<ToolResult> => {
        if (!c.tool) return { content: `Unknown tool: ${c.name}`, isError: true };
        try {
          return await c.tool.execute(c.parsed, {
            cancellation,
            emitProgress: () => {
              /* no-op */
            }
          });
        } catch (err) {
          return { content: `Tool error: ${String(err)}`, isError: true };
        }
      };

      const isUnsafe = (c: PreparedCall): boolean => !!c.tool && c.tool.parallelSafe === false;
      const results: ToolResult[] = new Array(prepared.length);

      // Walk the prepared list, grouping contiguous parallel-safe calls into
      // batches that are executed concurrently. Unsafe tools (ask_user,
      // propose_edit, update_plan, ...) run alone and in order so their UI
      // / shared-state side effects stay deterministic.
      let cursor = 0;
      while (cursor < prepared.length) {
        if (cancellation.isCancellationRequested) break;
        if (isUnsafe(prepared[cursor])) {
          const c = prepared[cursor];
          const result = await executeOne(c);
          results[cursor] = result;
          yield {
            type: 'tool-call-end',
            payload: { name: c.name, id: c.callId, result: result.content, isError: !!result.isError, meta: result.meta }
          };
          cursor++;
          continue;
        }

        // Collect the next contiguous run of parallel-safe calls.
        let end = cursor;
        while (end < prepared.length && !isUnsafe(prepared[end])) end++;
        const batchStart = cursor;
        const batchSize = end - batchStart;

        // Dispatch every call in the batch immediately and stream their
        // tool-call-end events to the UI as each one resolves (out of
        // dispatch order — whichever finishes first speaks first), so the
        // user sees individual yellow dots flip green as work completes.
        const completionQueue: number[] = []; // batch-relative indices
        let inFlight = batchSize;
        let resolveWaiter: (() => void) | null = null;
        for (let bi = 0; bi < batchSize; bi++) {
          const absIdx = batchStart + bi;
          executeOne(prepared[absIdx]).then((res) => {
            results[absIdx] = res;
            completionQueue.push(bi);
            inFlight--;
            const r = resolveWaiter;
            resolveWaiter = null;
            r?.();
          });
        }
        while (inFlight > 0 || completionQueue.length > 0) {
          while (completionQueue.length > 0) {
            const bi = completionQueue.shift() as number;
            const c = prepared[batchStart + bi];
            const res = results[batchStart + bi];
            yield {
              type: 'tool-call-end',
              payload: { name: c.name, id: c.callId, result: res.content, isError: !!res.isError, meta: res.meta }
            };
          }
          if (inFlight > 0) {
            await new Promise<void>((r) => {
              resolveWaiter = r;
            });
          }
        }
        cursor = end;
      }

      // Push tool replies back into conversation memory in ORIGINAL order so
      // every tool message lines up with its assistant tool_calls entry.
      for (let i = 0; i < prepared.length; i++) {
        const c = prepared[i];
        const result = results[i];
        if (!result) continue; // can happen if cancelled mid-batch
        messages.push({
          role: 'tool',
          tool_call_id: c.callId,
          content: result.content
        } as ChatMessage);
      }
      // propose_edit is non-blocking: the model gets a "queued" tool reply and
      // we just keep iterating. The user can accept/reject the queued edits
      // at any time — even after this run finishes — via the chat banner.

      // ---------------- Stuck detection ----------------
      // If the model keeps issuing the SAME tool-call batch (same names +
      // canonicalized args) turn after turn, it's almost always looping. We
      // apply two layers of escalation:
      //   1. 1st repeat (2 identical turns in a row): inject a self-correction
      //      user message and let the model try once more.
      //   2. >= `maxStuckRepeats` (default: 3 identical turns): escalate to
      //      askUser so the human can give a hint, continue, or abort. When
      //      no askUser is wired up we bail out with reason 'stuck' rather
      //      than burn the rest of `maxIterations`.
      const sig = toolCallSetSignature(toolCalls);
      if (sig === lastToolCallSignature) {
        consecutiveRepeats++;
        const callsDesc = describeCalls(toolCalls);
        if (consecutiveRepeats >= maxStuckRepeats) {
          // Layer 2: ask the user.
          this.logger.warn(
            `Stuck detected: ${consecutiveRepeats + 1} identical tool-call turns (${callsDesc}); escalating to askUser.`
          );
          yield {
            type: 'stuck-detected',
            payload: {
              repeats: consecutiveRepeats + 1,
              calls: callsDesc,
              action: 'ask-user'
            }
          };
          if (!this.options.askUser) {
            yield { type: 'done', payload: { reason: 'stuck' } };
            return;
          }
          let answer = '';
          try {
            answer = await this.options.askUser({
              question:
                `The agent appears to be stuck — it has called ${callsDesc} ${consecutiveRepeats + 1} times in a row with identical arguments. How would you like to proceed?`,
              inputType: 'single',
              options: [
                { label: 'Continue', description: 'Let the agent try a few more iterations on its own.' },
                { label: 'Stop', description: 'Abort this run.' }
              ],
              allowCustomText: true,
              placeholder: 'Or type a hint / new instruction…'
            });
          } catch (err) {
            this.logger.warn('askUser threw during stuck escalation', String(err));
          }
          const trimmed = answer.trim();
          const lower = trimmed.toLowerCase();
          if (!trimmed || lower === 'stop' || trimmed === '(cancelled by user)') {
            yield { type: 'done', payload: { reason: 'aborted-stuck' } };
            return;
          }
          if (lower !== 'continue') {
            // Treat any custom text as a new user instruction.
            messages.push({ role: 'user', content: trimmed });
          }
          // Reset detection state so the agent gets a fresh slate after the
          // user has weighed in.
          lastToolCallSignature = null;
          consecutiveRepeats = 0;
          continue;
        }
        // Layer 1: automatic self-correction nudge.
        this.logger.info(
          `Stuck detected: ${consecutiveRepeats + 1} identical tool-call turns (${callsDesc}); injecting self-correction.`
        );
        messages.push({
          role: 'user',
          content:
            `[stuck-detector] You just issued the same tool call(s) (${callsDesc}) with identical arguments as the previous turn — the result has not changed. ` +
            `Stop repeating yourself: either try a different approach (different arguments, a different tool, or read a different file), or give your final answer to the user. ` +
            `Do NOT issue the same tool call with the same arguments again.`
        });
        yield {
          type: 'stuck-detected',
          payload: {
            repeats: consecutiveRepeats + 1,
            calls: callsDesc,
            action: 'self-correct'
          }
        };
      } else {
        consecutiveRepeats = 0;
      }
      lastToolCallSignature = sig;
    }

    yield { type: 'done', payload: { reason: 'max_iterations' } };
  }
}
