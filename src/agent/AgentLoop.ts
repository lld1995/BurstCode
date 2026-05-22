import * as vscode from 'vscode';
import { ChatMessage, OpenAIClient, ToolDef } from '../llm/OpenAIClient';
import { Tool, ToolResult } from './tools/types';
import { FALLBACK_SYSTEM_PROMPT } from './prompts';
import { compressMessages, defaultCompressorConfig, normalizeToolResult } from '../context/Compressor';
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
    | 'tool-progress'
    | 'iteration-start'
    | 'auto-continue'
    | 'auto-resume'
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
const DEFAULT_MAX_PREMATURE_STOP_CONTINUES = 2;

type AccumulatedToolCall = { id?: string; name: string; arguments: string };

function decodeDsmlText(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function parseDsmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeDsmlText(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

function coerceDsmlParameter(value: string, attrs: Record<string, string>): unknown {
  const decoded = decodeDsmlText(value);
  if (attrs.string === 'true') return decoded;
  const trimmed = decoded.trim();
  if (!trimmed) return decoded;
  try {
    return JSON.parse(trimmed);
  } catch {
    return decoded;
  }
}

function extractDsmlToolCalls(text: string): { text: string; calls: AccumulatedToolCall[] } {
  const calls: AccumulatedToolCall[] = [];
  const dsml = '[|｜]DSML[|｜]';
  const blockRe = new RegExp(`<${dsml}tool_calls\\b[^>]*>([\\s\\S]*?)<\\/${dsml}tool_calls>`, 'g');
  const invokeRe = new RegExp(`<${dsml}invoke\\b([^>]*)>([\\s\\S]*?)<\\/${dsml}invoke>`, 'g');
  const paramRe = new RegExp(`<${dsml}parameter\\b([^>]*)>([\\s\\S]*?)<\\/${dsml}parameter>`, 'g');

  let cleaned = text;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text))) {
    let invoke: RegExpExecArray | null;
    while ((invoke = invokeRe.exec(block[1]))) {
      const invokeAttrs = parseDsmlAttributes(invoke[1]);
      const name = invokeAttrs.name;
      if (!name) continue;
      const args: Record<string, unknown> = {};
      let param: RegExpExecArray | null;
      while ((param = paramRe.exec(invoke[2]))) {
        const paramAttrs = parseDsmlAttributes(param[1]);
        const paramName = paramAttrs.name;
        if (!paramName) continue;
        args[paramName] = coerceDsmlParameter(param[2], paramAttrs);
      }
      calls.push({ name, arguments: JSON.stringify(args) });
    }
  }

  if (calls.length > 0) {
    cleaned = cleaned.replace(blockRe, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  return { text: cleaned, calls };
}

function hasOpenFence(text: string): boolean {
  const matches = text.match(/```/g);
  return !!matches && matches.length % 2 === 1;
}

function asksUserQuestion(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  return (
    /[?？]\s*(?:[`'")\]}）】]*)$/.test(trimmed) ||
    /[?？]/.test(trimmed.slice(-240)) ||
    [
      'which would you prefer',
      'what would you like',
      'do you want me to',
      'should i',
      'please confirm',
      '请确认',
      '你希望',
      '你想',
      '是否需要',
      '要不要',
      '需要我'
    ].some((marker) => lower.includes(marker))
  );
}

function hasConclusiveSignal(text: string): boolean {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return false;
  if (
    [
      'done',
      'completed',
      'fixed',
      'implemented',
      'updated',
      'verified',
      'summary',
      'conclusion',
      'root cause',
      '已完成',
      '完成了',
      '已修复',
      '修复了',
      '已更新',
      '已经',
      '总结',
      '结论',
      '原因是',
      '可以了',
      '验证通过',
      '处理好了'
    ].some((marker) => lower.includes(marker))
  ) {
    return true;
  }
  return /[.!。！]\s*(?:[`'")\]}）】]*)$/.test(trimmed);
}

function looksIncompleteFinalAnswer(text: string, afterTools: boolean): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (hasOpenFence(trimmed)) return true;
  if (/[:：,，;；\-—…]\s*(?:[`'")\]}）】]*)$/.test(trimmed)) return true;
  const hasIncompleteMarker = [
    'i need to',
    'i should',
    "i'll",
    'i will',
    'let me',
    'next i',
    'still need',
    'need to continue',
    'not finished',
    'not complete',
    'todo',
    '还需要',
    '尚未',
    '未完成',
    '没解决',
    '需要继续',
    '下一步',
    '我将',
    '我会',
    '我需要',
    '接下来',
    '继续',
    '待办'
  ].some((marker) => lower.includes(marker));
  if (hasIncompleteMarker) return true;
  if (afterTools && !hasConclusiveSignal(trimmed) && !asksUserQuestion(trimmed)) return true;
  return false;
}

function buildPrematureStopPrompt(reason: string): string {
  return `[auto-continue] You stopped before the task was clearly complete (${reason}). Re-check the user's original request and all tool results. If anything remains unresolved, continue by calling the appropriate tools or proposing edits. Only finish when you can give a concrete final answer that directly answers the question or states exactly what was completed, or ask the user a clear question if you are blocked.`;
}

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
   * Auto-retry the in-flight turn when the LLM stream is interrupted by a
   * transient error (network drop, server reset, HTTP 5xx, abort, ...).
   * When false, the agent ends the run with reason 'error' as before.
   */
  autoResumeOnStreamError: boolean;
  /** Cap on consecutive auto-resumes (resets after any successful streaming turn). */
  maxAutoResumes: number;
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
  autoContinueOnPrematureStop?: boolean;
  maxPrematureStopContinues?: number;
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
    let consecutivePrematureStopContinues = 0;
    let sawToolCallsThisRun = false;
    const autoContinueOnPrematureStop = this.options.autoContinueOnPrematureStop ?? true;
    const maxPrematureStopContinues = Math.max(
      0,
      this.options.maxPrematureStopContinues ?? DEFAULT_MAX_PREMATURE_STOP_CONTINUES
    );

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
        contextWindow: this.options.contextWindow,
        inputBudgetRatio: 0.6,
        keepLastN: 3
      });

      let assistantText = '';
      let reasoningText = '';
      const toolCallAccumulator = new Map<
        number,
        { id?: string; name: string; arguments: string }
      >();
      let finishReason: string | undefined;

      // Auto-resume on transient stream errors. We retry the whole turn
      // (same compressed messages) and reset the per-attempt accumulators so
      // the next streaming pass starts from a clean slate. The webview also
      // discards any partial assistant bubble on receipt of `auto-resume` so
      // the user does not see duplicated text.
      const maxResumes = this.options.autoResumeOnStreamError
        ? Math.max(0, this.options.maxAutoResumes)
        : 0;
      let resumeAttempt = 0;
      let streamOk = false;
      while (!streamOk) {
        // Reset per-attempt streaming state.
        assistantText = '';
        reasoningText = '';
        toolCallAccumulator.clear();
        finishReason = undefined;
        try {
          // Overall timeout for the LLM stream: if chunks stop arriving for
          // 120s, treat it as a stream error and either retry or surface it.
          // This prevents the for-await from hanging forever on a half-open
          // connection or a slow LLM.
          const STREAM_TIMEOUT_MS = 120_000;
          // Sentinel distinguishes a real iterator end from a timeout expiry.
          // Using { done: true } for both would silently treat timeout as
          // normal completion (the timeout throw below would be dead code).
          const STREAM_TIMEOUT_SENTINEL = Symbol('stream-timeout');
          const streamIter = this.client.streamChat(compressed, this.toolDefs(), cancellation)[Symbol.asyncIterator]();
          let streamDone = false;
          while (!streamDone) {
            if (cancellation.isCancellationRequested) break;
            const result = await Promise.race([
              streamIter.next(),
              new Promise<typeof STREAM_TIMEOUT_SENTINEL>((resolve) =>
                setTimeout(() => resolve(STREAM_TIMEOUT_SENTINEL), STREAM_TIMEOUT_MS)
              )
            ]);
            if (result === STREAM_TIMEOUT_SENTINEL) {
              throw new Error(`LLM stream timed out after ${STREAM_TIMEOUT_MS}ms`);
            }
            if (result.done) {
              streamDone = true;
              break;
            }
            const chunk = result.value;
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
          if (cancellation.isCancellationRequested) {
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          streamOk = true;
        } catch (err) {
          // User-driven cancellation: don't retry, end cleanly so the run
          // surfaces the 'cancelled' reason rather than a noisy error.
          if (cancellation.isCancellationRequested) {
            this.logger.info(`LLM stream cancelled by user: ${String(err)}`);
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          if (resumeAttempt >= maxResumes) {
            this.logger.error('LLM stream error', String(err));
            const detail = String(err);
            const suffix =
              maxResumes > 0
                ? ` (after ${resumeAttempt} auto-resume${resumeAttempt === 1 ? '' : 's'})`
                : '';
            yield { type: 'error', payload: `Stream interrupted${suffix}: ${detail}` };
            return;
          }
          resumeAttempt++;
          const delayMs = Math.min(500 * 2 ** (resumeAttempt - 1), 4000);
          this.logger.warn(
            `LLM stream interrupted (attempt ${resumeAttempt}/${maxResumes}); resuming in ${delayMs}ms: ${String(err)}`
          );
          yield {
            type: 'auto-resume',
            payload: {
              attempt: resumeAttempt,
              max: maxResumes,
              error: String(err),
              delayMs
            }
          };
          // Cancellable sleep before the next attempt.
          const cancelled = await new Promise<boolean>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const sub = cancellation.onCancellationRequested(() => {
              if (timer !== undefined) clearTimeout(timer);
              sub.dispose();
              resolve(true);
            });
            timer = setTimeout(() => {
              sub.dispose();
              resolve(false);
            }, delayMs);
          });
          if (cancelled) {
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
        }
      }

      let toolCalls = Array.from(toolCallAccumulator.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
        .filter((v) => v.name);
      const inlineDsml = extractDsmlToolCalls(assistantText);
      if (inlineDsml.calls.length > 0) {
        assistantText = inlineDsml.text;
        if (toolCalls.length === 0) {
          toolCalls = inlineDsml.calls;
        }
      }

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
      if (toolCalls.length === 0 && finishReason === 'tool_calls') {
        if (
          autoContinueOnPrematureStop &&
          consecutivePrematureStopContinues < maxPrematureStopContinues
        ) {
          consecutivePrematureStopContinues++;
          messages.push({
            role: 'user',
            content: buildPrematureStopPrompt('finish_reason=tool_calls but no valid tool call was received')
          });
          yield {
            type: 'auto-continue',
            payload: { count: consecutivePrematureStopContinues, max: maxPrematureStopContinues }
          };
          continue;
        }
        const detail =
          'Model ended with finish_reason=tool_calls, but no valid tool call was received. The run cannot continue safely because the tool-call stream was empty or malformed.';
        this.logger.error(detail);
        yield { type: 'assistant-message', payload: { text: assistantText, toolCalls: 0 } };
        yield { type: 'error', payload: detail };
        return;
      }
      if (toolCalls.length === 0 && finishReason !== 'length' && assistantText.trim().length === 0) {
        if (
          autoContinueOnPrematureStop &&
          consecutivePrematureStopContinues < maxPrematureStopContinues
        ) {
          consecutivePrematureStopContinues++;
          messages.push({
            role: 'user',
            content: buildPrematureStopPrompt(`empty assistant turn, finish_reason=${finishReason ?? 'missing'}`)
          });
          yield {
            type: 'auto-continue',
            payload: { count: consecutivePrematureStopContinues, max: maxPrematureStopContinues }
          };
          continue;
        }
        const detail =
          `Model ended without a user-visible answer or a tool call (finish_reason=${finishReason ?? 'missing'}).`;
        this.logger.error(detail);
        yield { type: 'assistant-message', payload: { text: assistantText, toolCalls: 0 } };
        yield { type: 'error', payload: detail };
        return;
      }
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
        if (
          finishReason !== 'length' &&
          autoContinueOnPrematureStop &&
          consecutivePrematureStopContinues < maxPrematureStopContinues &&
          looksIncompleteFinalAnswer(assistantText, sawToolCallsThisRun)
        ) {
          consecutivePrematureStopContinues++;
          messages.push({
            role: 'user',
            content: buildPrematureStopPrompt(`assistant final answer looked incomplete, finish_reason=${finishReason ?? 'missing'}`)
          });
          yield {
            type: 'auto-continue',
            payload: { count: consecutivePrematureStopContinues, max: maxPrematureStopContinues }
          };
          continue;
        }
        yield { type: 'done', payload: { reason: finishReason ?? 'stop' } };
        return;
      }

      // Tool calls were emitted: making real progress, reset the auto-continue budget.
      sawToolCallsThisRun = true;
      consecutiveAutoContinues = 0;
      consecutivePrematureStopContinues = 0;

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
            callId: c.callId,
            emitProgress: (message: string) => {
              progressQueue.push({ callId: c.callId, name: c.name, message });
              const r = resolveWaiter;
              resolveWaiter = null;
              r?.();
            }
          });
        } catch (err) {
          return { content: `Tool error: ${String(err)}`, isError: true };
        }
      };

      const isUnsafe = (c: PreparedCall): boolean => !!c.tool && c.tool.parallelSafe === false;
      const hasNoTimeout = (c: PreparedCall): boolean => !!c.tool && c.tool.noTimeout === true;
      const results: ToolResult[] = new Array(prepared.length);
      const progressQueue: Array<{ callId: string; name: string; message: string }> = [];
      // Hoisted so emitProgress (inside executeOne) can wake the batch drain loop.
      let resolveWaiter: (() => void) | null = null;

      // Walk the prepared list, grouping contiguous parallel-safe calls into
      // batches that are executed concurrently. Unsafe tools (ask_user,
      // update_plan, record_lesson, run_shell, ...) run alone and in order
      // so their UI / shared-state side effects stay deterministic.
      // propose_edit is parallel-safe: HunkApplier serializes per-file
      // mutations internally, so concurrent file writes do queue up safely.
      let cursor = 0;
      while (cursor < prepared.length) {
        if (cancellation.isCancellationRequested) break;
        if (isUnsafe(prepared[cursor])) {
          const c = prepared[cursor];
          const result = await executeOne(c);
          results[cursor] = result;
          while (progressQueue.length > 0) {
            const p = progressQueue.shift()!;
            yield { type: 'tool-progress', payload: { id: p.callId, name: p.name, message: p.message } };
          }
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
        resolveWaiter = null;
        let batchSettled = false;
        for (let bi = 0; bi < batchSize; bi++) {
          const absIdx = batchStart + bi;
          executeOne(prepared[absIdx]).then((res) => {
            // After batch timeout, batchSettled=true: discard the late result
            // rather than overwriting the sentinel and confusing callers.
            if (batchSettled && results[absIdx] !== undefined) return;
            results[absIdx] = res;
            completionQueue.push(bi);
            inFlight--;
            const r = resolveWaiter;
            resolveWaiter = null;
            r?.();
          });
        }
        // Safety timeout: if any executeOne promise never resolves (e.g. LSP
        // call hangs, shell subprocess zombie), we don't hang forever. Tools
        // that declare noTimeout:true (e.g. launch_subagent) are excluded
        // because they manage their own lifetime / cancellation.
        const batchHasNoTimeout = prepared.slice(batchStart, end).some((c) => hasNoTimeout(c));
        const BATCH_SAFETY_TIMEOUT_MS = batchHasNoTimeout ? 0 : 30_000;
        const batchDeadline = BATCH_SAFETY_TIMEOUT_MS > 0 ? Date.now() + BATCH_SAFETY_TIMEOUT_MS : Infinity;
        while ((inFlight > 0 || completionQueue.length > 0 || progressQueue.length > 0) && !batchSettled) {
          if (cancellation.isCancellationRequested) break;
          while (progressQueue.length > 0) {
            const p = progressQueue.shift()!;
            yield { type: 'tool-progress', payload: { id: p.callId, name: p.name, message: p.message } };
          }
          while (completionQueue.length > 0) {
            const bi = completionQueue.shift() as number;
            const c = prepared[batchStart + bi];
            const res = results[batchStart + bi];
            yield {
              type: 'tool-call-end',
              payload: { name: c.name, id: c.callId, result: res.content, isError: !!res.isError, meta: res.meta }
            };
          }
          if (inFlight > 0 || progressQueue.length > 0) {
            const remaining = batchDeadline - Date.now();
            if (remaining <= 0) {
              batchSettled = true;
              break;
            }
            await new Promise<void>((r) => {
              // Race between the next tool completing/reporting progress and the safety timeout.
              const waitMs = BATCH_SAFETY_TIMEOUT_MS > 0 ? Math.min(remaining, 5000) : 5000;
              const timer = setTimeout(() => {
                resolveWaiter = null;
                r();
              }, waitMs);
              const prevResolve = resolveWaiter;
              resolveWaiter = () => {
                clearTimeout(timer);
                prevResolve?.();
                r();
              };
            });
          }
        }
        if (batchSettled) {
          this.logger.warn(
            `Batch safety timeout after ${BATCH_SAFETY_TIMEOUT_MS}ms; ${inFlight} tool(s) still in flight`
          );
          // Mark remaining in-flight results as timed out so downstream code
          // (tool reply push) sees a non-null entry.
          for (let bi = 0; bi < batchSize; bi++) {
            const absIdx = batchStart + bi;
            if (results[absIdx] === undefined) {
              results[absIdx] = {
                content: `[tool timed out after ${BATCH_SAFETY_TIMEOUT_MS}ms]`,
                isError: true
              };
              const c = prepared[absIdx];
              yield {
                type: 'tool-call-end',
                payload: { name: c.name, id: c.callId, result: results[absIdx].content, isError: true, meta: undefined }
              };
            }
          }
        }
        cursor = end;
      }

      // Push tool replies back into conversation memory in ORIGINAL order so
      // every tool message lines up with its assistant tool_calls entry.
      // normalizeToolResult applies per-tool content reductions before storage
      // so the messages array stays lean from the start (grep caps, file caps, etc).
      for (let i = 0; i < prepared.length; i++) {
        const c = prepared[i];
        const result = results[i];
        if (!result) continue; // can happen if cancelled mid-batch
        const storedContent = normalizeToolResult(c.name, result.content);
        messages.push({
          role: 'tool',
          tool_call_id: c.callId,
          content: storedContent
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
