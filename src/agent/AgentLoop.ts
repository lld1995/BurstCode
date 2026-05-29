import * as vscode from 'vscode';
import { ChatMessage, OpenAIClient, ToolDef } from '../llm/OpenAIClient';
import { Tool, ToolResult } from './tools/types';
import { FALLBACK_SYSTEM_PROMPT } from './prompts';
import { compressMessages, defaultCompressorConfig, normalizeToolResult, pruneOrphanedToolResults } from '../context/Compressor';
import { estimateMessagesTokens } from '../llm/tokenizer';
import { Logger } from '../util/Logger';
import { repairJsonControlChars, repairJsonUnescapedQuotes } from '../util/jsonRepair';
import { HunkApplier } from '../edits/HunkApplier';
import { AskUserFn } from './tools/edits';

export interface AgentEvent {
  type:
    | 'assistant-delta'
    | 'assistant-message'
    | 'reasoning-delta'
    | 'tool-call-start'
    | 'tool-call-args-delta'
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
 * Only start orphan-pruning tool results once usage crosses this fraction of
 * the window. Below it the context is roomy, so pruning would only risk forcing
 * the model to re-read files it still wants — a net token + latency loss.
 */
const ORPHAN_PRUNE_TRIGGER_RATIO = 0.6;
/**
 * Recent-read grace window for orphan pruning: never prune the most recent N
 * prunable tool results even when their paths are absent downstream. Covers the
 * common "read now, edit a couple turns later" pattern so we don't churn reads.
 */
const ORPHAN_PRUNE_RECENT_GRACE = 6;

/**
 * Minimum cumulative read_file / collect_context calls before we even consider
 * injecting the context-offload hint. Below this count the context window is
 * almost certainly small enough that inline reads are fine.
 */
const CONTEXT_OFFLOAD_MIN_READS = 3;

/**
 * Only inject the offload hint when messages already occupy at least this
 * fraction of the model's context window. If the context is still small,
 * direct reads are cheaper and faster than spawning a sub-agent.
 */
const CONTEXT_OFFLOAD_TOKEN_RATIO = 0.4;

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

/**
 * Detects responses that are nothing but a short statement of intent to act,
 * with no execution and no result.
 *
 * We anchor the regexes to the BEGINNING of the LAST sentence and gate the
 * check on a small total length so we don't false-positive on long answers
 * that legitimately contain phrases like "I'll", "let me", "接下来", "继续"
 * in benign positions (e.g. "Let me know if you have questions", "您可以
 * 继续使用此功能", "接下来您可以…").
 */
function endsWithIntentToActOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 160) return false;
  const sentences = trimmed.split(/(?<=[.!。！?？])\s+/);
  const last = (sentences[sentences.length - 1] ?? trimmed).trim().toLowerCase();
  if (!last) return false;
  const intentRe: RegExp[] = [
    /^i'?ll\s/i,
    /^i will\s/i,
    /^i'?m going to\s/i,
    /^i am going to\s/i,
    /^let me\s/i,
    /^i need to\s/i,
    /^i should\s/i,
    /^next i'?ll\s/i,
    /^next i will\s/i,
    /^now i'?ll\s/i,
    /^now i will\s/i,
    /^(?:我将|我会|我需要|让我|接下来我|下一步我|现在我|我打算|我准备)/
  ];
  return intentRe.some((re) => re.test(last));
}

/**
 * Decide whether the model's final assistant turn looks truncated mid-thought
 * rather than a genuine finished answer. Intentionally CONSERVATIVE: only
 * fire on strong, unambiguous signs of truncation. Soft heuristics like
 * "after tools the response must end with a period or contain '完成'" were
 * removed because they fired on many legitimately-complete answers (e.g.
 * Chinese sentences not ending in 。, code blocks as the final element,
 * markdown tables, file/symbol references, polite closers).
 */
function looksIncompleteFinalAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Truncated mid code block.
  if (hasOpenFence(trimmed)) return true;
  // Explicit "to be continued" — trailing ellipsis with no follow-up.
  if (/(?:…|\.{3})\s*$/.test(trimmed)) return true;
  // Dangling list/clause punctuation: a real answer almost never ends like this.
  // Dashes (- —) and sentence-ending periods are intentionally excluded.
  if (/[:：,，;；]\s*(?:[`'")\]}）】]*)$/.test(trimmed)) return true;
  // Short responses that read as pure plans without any execution result.
  if (endsWithIntentToActOnly(trimmed)) return true;
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

function isContextLengthError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  if (msg.includes('context_length_exceeded')) return true;
  if (msg.includes('maximum context length')) return true;
  if (msg.includes('reduce the length')) return true;
  if (msg.includes('context window') && (msg.includes('exceed') || msg.includes('too long'))) return true;
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code === 'context_length_exceeded') return true;
  }
  return false;
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
   * `runTools` are additional per-run tools (e.g. compress_context, save_topic_doc)
   * that capture run-specific state (live messages array, workspace root) via closure.
   */
  async *run(
    messages: ChatMessage[],
    cancellation: vscode.CancellationToken,
    runTools?: Tool[]
  ): AsyncGenerator<AgentEvent, void, void> {
    // Merge base tools with per-run tools. Per-run tools shadow base tools of
    // the same name (allowing overrides) and capture run-specific state via closure.
    const runToolMap = new Map(this.toolMap);
    for (const t of runTools ?? []) runToolMap.set(t.name, t);
    const allToolDefs: ToolDef[] = [
      ...this.tools.map((t) => t.schema),
      ...(runTools ?? []).map((t) => t.schema)
    ];

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
    let consecutiveContextErrors = 0;
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

    // ---- propose_edit decision feedback ----
    // Without this, when the user accepts/rejects pending edits while the
    // agent is still running, the model has no way of knowing that the file
    // it last saw via read_file may now have stale line numbers. We buffer
    // each fully-drained file's decision summary here and inject it as a
    // user-role notice at the next iteration boundary so the model knows to
    // re-read before any follow-up propose_edit.
    const decisionBuffer: string[] = [];
    const decisionSub = this.applier.onPendingStateChange((state) => {
      if (state.recentDecision) decisionBuffer.push(state.recentDecision);
    });

    // ---- context-offload hint state ----
    // Counts cumulative read_file + collect_context calls this run.
    // A one-shot hint is injected once the threshold is crossed.
    let cumulativeReadCalls = 0;
    let offloadHintInjected = false;

    try {
    outerLoop: for (let iter = 0; iter < this.options.maxIterations; iter++) {
      if (cancellation.isCancellationRequested) {
        yield { type: 'done', payload: { reason: 'cancelled' } };
        return;
      }
      yield { type: 'iteration-start', payload: { iter } };

      // If the user accepted or rejected pending edits since the last turn,
      // surface a one-shot notice so the model invalidates its line-number
      // cache for those files. Drained here (not on the emitter) so the
      // notice always lands BEFORE the next compression / model call.
      if (decisionBuffer.length > 0) {
        const drained = decisionBuffer.splice(0).join(' | ');
        messages.push({
          role: 'user',
          content:
            `[user-decision] ${drained}\n` +
            `Any file that just drained has been written to disk (or had its pending hunks discarded). ` +
            `If you plan to issue another propose_edit on those files, re-read them with read_file first — ` +
            `the line numbers you saw via the post-edit preview are now stale.`
        });
      }

      // Measure persistent context usage and auto-compress in place when we
      // cross the high-water mark. Compressing the persistent `messages`
      // array (rather than only the per-turn snapshot below) is what frees
      // memory across future turns and keeps the UI gauge in sync with the
      // session that gets persisted to disk.
      const ctxMax = this.options.contextWindow;
      let usedTokens = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);

      // ── Orphan-prune pass (pressure-gated) ────────────────────────────────
      // Collapse tool results whose file paths are never referenced again in
      // later messages. Runs BEFORE zone compression so the compressor has
      // less to work with. Safe: never deletes messages, never touches the
      // last keepLastN exchanges, only prunes when ALL extracted paths are
      // absent from all downstream content.
      //
      // Gated two ways to avoid forcing the model into wasteful re-reads:
      //   1. Only run once usage crosses ORPHAN_PRUNE_TRIGGER_RATIO — while the
      //      window is roomy, keeping reads around is cheaper than re-fetching.
      //   2. Exempt the most recent ORPHAN_PRUNE_RECENT_GRACE tool results, so a
      //      file read "now" survives long enough for a follow-up propose_edit.
      const pruneCount =
        ctxMax > 0 && usedTokens / ctxMax > ORPHAN_PRUNE_TRIGGER_RATIO
          ? pruneOrphanedToolResults(
              messages,
              defaultCompressorConfig.keepLastN,
              ORPHAN_PRUNE_RECENT_GRACE
            )
          : 0;
      if (pruneCount > 0) {
        const afterPrune = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
        this.logger.info(
          `Orphan-prune: collapsed ${pruneCount} stale tool result(s); ${usedTokens} → ${afterPrune} tokens.`
        );
        usedTokens = afterPrune;
      }

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
        keepLastN: 1
      });

      let assistantText = '';
      let reasoningText = '';
      const toolCallAccumulator = new Map<
        number,
        { id?: string; name: string; arguments: string }
      >();
      const preAnnounced = new Set<number>();
      const argDeltaBuffers = new Map<string, string>(); // id -> buffered arg text not yet emitted
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
        preAnnounced.clear();
        argDeltaBuffers.clear();
        finishReason = undefined;
        // Overall timeout for the LLM stream: if chunks stop arriving for
        // 120s, treat it as a stream error and either retry or surface it.
        // This prevents the for-await from hanging forever on a half-open
        // connection or a slow LLM.
        const STREAM_TIMEOUT_MS = 120_000;
        // Sentinel distinguishes a real iterator end from a timeout expiry.
        // Using { done: true } for both would silently treat timeout as
        // normal completion (the timeout throw below would be dead code).
        const STREAM_TIMEOUT_SENTINEL = Symbol('stream-timeout');
        // Hoisted so the `finally` below can clean up the generator on any
        // non-natural exit (timeout, mid-stream cancellation, thrown error).
        // Without that cleanup, every leaked iterator keeps the underlying
        // OpenAI HTTP socket open while the next auto-resume opens a fresh
        // one — the server then sees N concurrent identical requests on
        // the wire, exactly the "大量并发相同的请求" symptom.
        const streamIter = this.client.streamChat(
          compressed,
          allToolDefs,
          cancellation
        )[Symbol.asyncIterator]();
        let streamConsumed = false;
        try {
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
              streamConsumed = true;
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
              // Pre-announce: emit tool-call-start as soon as the tool NAME is known.
              // Do NOT require entry.id — many OpenAI-compatible models omit id from
              // streaming deltas and only set it in the final assistant message.
              if (!preAnnounced.has(idx) && entry.name) {
                preAnnounced.add(idx);
                yield { type: 'tool-call-start', payload: { name: entry.name, id: entry.id, args: {}, streaming: true } };
              }
              // Stream argument text to UI. Use idx (stable integer index) as the
              // buffer key so we don't need entry.id, which may be absent.
              if (preAnnounced.has(idx) && chunk.toolCallDelta.argumentsDelta) {
                const bufKey = String(idx);
                const prev = argDeltaBuffers.get(bufKey) ?? '';
                const next = prev + chunk.toolCallDelta.argumentsDelta;
                if (next.length >= 40) {
                  argDeltaBuffers.set(bufKey, '');
                  yield { type: 'tool-call-args-delta', payload: { id: entry.id, delta: next } };
                } else {
                  argDeltaBuffers.set(bufKey, next);
                }
              }
            }
            if (chunk.finishReason) finishReason = chunk.finishReason;
          }
          if (cancellation.isCancellationRequested) {
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          streamOk = true;
          // Flush any buffered arg delta text that didn't reach the 40-char threshold.
          // The buffer keys are String(idx), not entry.id — send id:undefined so the
          // webview falls back to activeStreamingToolEl for element lookup.
          for (const [, buf] of argDeltaBuffers) {
            if (buf) yield { type: 'tool-call-args-delta', payload: { id: undefined, delta: buf } };
          }
          argDeltaBuffers.clear();
          // Empty response with no finish_reason = transient backend issue (silent
          // dropped body, vLLM/sglang returning nothing).  Treat exactly like a
          // stream error: auto-resume up to maxResumes times, then terminate the
          // run with an error.  We MUST NOT fall through to the auto-continue path
          // here — resumeAttempt resets each for-iteration, so letting auto-continue
          // trigger a new iteration would give the stream another full resume budget
          // and produce an infinite loop.
          if (
            finishReason === undefined &&
            assistantText.length === 0 &&
            toolCallAccumulator.size === 0
          ) {
            if (resumeAttempt < maxResumes) {
              streamOk = false;
              resumeAttempt++;
              const delayMs = Math.min(500 * 2 ** (resumeAttempt - 1), 4_000);
              this.logger.warn(
                `Empty response with missing finish_reason (resume ${resumeAttempt}/${maxResumes}); retrying in ${delayMs}ms`
              );
              yield {
                type: 'auto-resume',
                payload: {
                  attempt: resumeAttempt,
                  max: maxResumes,
                  error: 'empty response (finish_reason missing)',
                  delayMs
                }
              };
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
              continue;
            }
            // All auto-resumes exhausted — end the run rather than falling through
            // to auto-continue, which would reset resumeAttempt on the next iteration.
            const suffix = resumeAttempt > 0
              ? ` (after ${resumeAttempt} auto-resume${resumeAttempt === 1 ? '' : 's'})`
              : '';
            const detail = `Model returned an empty response with no finish_reason${suffix}. This is likely a transient backend issue.`;
            this.logger.error(detail);
            yield { type: 'error', payload: detail };
            return;
          }
        } catch (err) {
          // User-driven cancellation: don't retry, end cleanly so the run
          // surfaces the 'cancelled' reason rather than a noisy error.
          if (cancellation.isCancellationRequested) {
            this.logger.info(`LLM stream cancelled by user: ${String(err)}`);
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          // Context-length errors cannot be fixed by retrying the same request.
          // Force-compress the persistent message array and retry via the outer
          // loop so the model gets a fresh (smaller) context window.
          if (isContextLengthError(err)) {
            if (consecutiveContextErrors >= 3) {
              const detail = `Context length exceeded and compression failed to reduce it sufficiently: ${String(err)}`;
              this.logger.error(detail);
              yield { type: 'error', payload: detail };
              return;
            }
            consecutiveContextErrors++;
            const ctxMaxForCompress = ctxMax > 0 ? ctxMax : defaultCompressorConfig.contextWindow;
            const before = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
            const targetRatio = Math.max(0.15, 0.35 - consecutiveContextErrors * 0.08);
            const compacted = compressMessages(messages, {
              ...defaultCompressorConfig,
              contextWindow: ctxMaxForCompress,
              inputBudgetRatio: targetRatio
            });
            messages.splice(0, messages.length, ...compacted);
            const after = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
            this.logger.warn(
              `Context length error — force-compressed: ${before} → ${after} tokens (attempt ${consecutiveContextErrors}/3, targetRatio=${targetRatio})`
            );
            yield {
              type: 'context-compressed',
              payload: { before, after, max: ctxMaxForCompress, forced: true }
            };
            continue outerLoop;
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
        } finally {
          // Clean up the inner generator on any non-natural exit (timeout
          // throw, mid-stream cancellation break, thrown SDK error). This
          // propagates through `streamChat`'s `for await`, which fires the
          // OpenAI SDK's AbortController and closes the HTTP socket on the
          // wire — otherwise each auto-resume leaves the previous request
          // hanging server-side and the user observes many concurrent
          // identical requests instead of a single in-flight one.
          if (!streamConsumed) {
            try {
              await streamIter.return?.(undefined);
            } catch {
              /* cleanup errors are not actionable */
            }
          }
        }
      }

      // Successful stream — reset context-error counter so a single context error
      // in a long session doesn't permanently reduce the 3-attempt budget.
      consecutiveContextErrors = 0;

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
          looksIncompleteFinalAnswer(assistantText)
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
        /**
         * Set when `tc.arguments` couldn't be parsed as JSON (truncated
         * stream, malformed escapes, etc). When non-null we short-circuit
         * `executeOne` and surface a clear parse-error message back to the
         * LLM instead of calling the tool with an empty `{}` — otherwise
         * the model gets a misleading "field X is missing" error and loops.
         */
        parseError?: string;
        rawArgs?: string;
      }
      const prepared: PreparedCall[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        if (!tc.name) continue;
        const callId = finalCalls[i]?.id ?? `call_${Date.now()}_${i}`;
        let parsed: Record<string, unknown> = {};
        let parseError: string | undefined;
        if (tc.arguments) {
          try {
            parsed = JSON.parse(tc.arguments);
          } catch (err) {
            // The LLM's most common JSON-emission bug is embedding raw
            // control characters (literal TAB / NEWLINE / CR bytes) inside
            // string values when copying file content for oldText/newText.
            // Try a tolerant repair pass — escape control chars that lie
            // INSIDE string literals — before declaring defeat.
            const repaired = repairJsonControlChars(tc.arguments);
            const afterControl = repaired ?? tc.arguments;
            try {
              parsed = JSON.parse(afterControl);
              if (repaired !== null)
                this.logger.info(`Tool args ${tc.name}: parsed after control-char repair`);
            } catch (err2) {
              // Also try escaping unescaped quotes (e.g. Python """ docstrings in newText).
              const quoteRepaired = repairJsonUnescapedQuotes(afterControl);
              if (quoteRepaired !== null) {
                try {
                  parsed = JSON.parse(quoteRepaired);
                  this.logger.info(`Tool args ${tc.name}: parsed after unescaped-quote repair`);
                } catch (err3) {
                  parseError = err3 instanceof Error ? err3.message : String(err3);
                }
              } else {
                parseError = err2 instanceof Error ? err2.message : String(err2);
              }
            }
            if (parseError) {
              this.logger.warn('Tool args parse failed', tc.name, parseError, tc.arguments);
            }
          }
        }
        prepared.push({
          index: i,
          name: tc.name,
          callId,
          parsed,
          tool: runToolMap.get(tc.name),
          parseError,
          rawArgs: tc.arguments
        });
      }

      // Emit tool-call-start events in original order so the chat panel
      // renders a stable left-to-right tree, even when we run them in
      // parallel below. Tools already pre-announced during streaming get an
      // update (args now resolved) instead of a fresh insert.
      for (const c of prepared) {
        yield { type: 'tool-call-start', payload: { name: c.name, args: c.parsed, id: c.callId, update: preAnnounced.has(c.index) } };
      }

      const executeOne = async (c: PreparedCall): Promise<ToolResult> => {
        if (!c.tool) return { content: `Unknown tool: ${c.name}`, isError: true };
        if (c.parseError) {
          // Show the model the actual parse error AND a head/tail snippet of
          // what we received, so it can see whether its JSON was truncated
          // (long oldText/newText overflowing the model's per-call output
          // budget is the usual cause) or just malformed (bad escape, stray
          // newline inside a string, etc). Without this hint, the LLM gets
          // a downstream "field X is missing" from the tool and retries the
          // same broken JSON.
          const raw = c.rawArgs ?? '';
          const HEAD = 600;
          const TAIL = 200;
          const snippet =
            raw.length > HEAD + TAIL
              ? `${raw.slice(0, HEAD)}\n... [truncated ${raw.length - HEAD - TAIL} chars] ...\n${raw.slice(-TAIL)}`
              : raw;
          return {
            content:
              `Tool '${c.name}' args could not be parsed as JSON: ${c.parseError}.\n` +
              `Re-issue the call with valid JSON. If you were embedding a long string ` +
              `(oldText / newText / file contents), make sure all backslashes (\\\\), ` +
              `double-quotes (\\"), and newlines (\\n) are properly escaped, and that ` +
              `the JSON wasn't truncated by your output token budget — split the work ` +
              `into multiple smaller propose_edit calls if needed.\n` +
              `Received args (length=${raw.length}):\n${snippet}`,
            isError: true
          };
        }
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
          // Run the unsafe tool and drain its progress events in real-time.
          // Uses the same resolveWaiter mechanism as the parallel-safe batch
          // loop below: emitProgress() calls wake the drain loop immediately
          // instead of accumulating until executeOne() returns.
          let unsafeDone = false;
          let unsafeResult: ToolResult | undefined;
          executeOne(c).then((res) => {
            unsafeResult = res;
            unsafeDone = true;
            const r = resolveWaiter;
            resolveWaiter = null;
            r?.();
          });
          while (!unsafeDone || progressQueue.length > 0) {
            if (cancellation.isCancellationRequested) break;
            while (progressQueue.length > 0) {
              const p = progressQueue.shift()!;
              yield { type: 'tool-progress', payload: { id: p.callId, name: p.name, message: p.message } };
            }
            if (!unsafeDone) {
              // Wait for either a progress event or tool completion.
              // 500 ms fallback prevents a missed wakeup from hanging forever.
              await new Promise<void>((r) => {
                resolveWaiter = r;
                setTimeout(r, 500);
              });
              resolveWaiter = null;
            }
          }
          const result = unsafeResult ?? { content: 'Tool did not produce a result.', isError: true };
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
        // Track cumulative heavy-read calls for context-offload hint.
        if (c.name === 'read_file' || c.name === 'collect_context') {
          cumulativeReadCalls++;
        }
        const storedContent = normalizeToolResult(c.name, result.content);
        messages.push({
          role: 'tool',
          tool_call_id: c.callId,
          content: storedContent
        } as ChatMessage);
      }

      // Inject a one-shot context-offload hint only when the context window is
      // already getting large AND the model has made several read calls.
      // Conditions (both must be true):
      //   1. cumulativeReadCalls >= CONTEXT_OFFLOAD_MIN_READS — don't nudge on
      //      the very first reads; small context means subagent overhead isn't
      //      worth it.
      //   2. Current messages already occupy >= CONTEXT_OFFLOAD_TOKEN_RATIO of
      //      the model's context window — only then is offloading worthwhile.
      if (!offloadHintInjected && cumulativeReadCalls >= CONTEXT_OFFLOAD_MIN_READS) {
        const usedTokens = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
        const contextWindow = this.options.contextWindow ?? 128_000;
        const usageRatio = usedTokens / contextWindow;
        if (usageRatio >= CONTEXT_OFFLOAD_TOKEN_RATIO) {
          offloadHintInjected = true;
          messages.push({
            role: 'user',
            content:
              `[context-offload hint] You have now called read_file / collect_context ` +
              `${cumulativeReadCalls} times in this run. Each call injects raw file content into ` +
              `the shared context window, which grows without bound and forces expensive ` +
              `compression. If you still need to read more files or gather more workspace ` +
              `context, STRONGLY PREFER delegating that work to launch_subagent: give the ` +
              `sub-agent a focused objective and let it read/grep inside its own isolated ` +
              `context window — only the concise summary comes back here. Reserve direct ` +
              `read_file / collect_context calls for single targeted lookups that cannot ` +
              `be delegated (e.g. re-reading a file you are about to propose_edit on).`
          });
          this.logger.info(
            `Context-offload hint injected after ${cumulativeReadCalls} reads (context usage: ${(usageRatio * 100).toFixed(1)}% of ${contextWindow} tokens).`
          );
        } else {
          this.logger.debug(
            `Context-offload hint suppressed: ${cumulativeReadCalls} reads but context only at ${(usageRatio * 100).toFixed(1)}% (threshold: ${(CONTEXT_OFFLOAD_TOKEN_RATIO * 100).toFixed(0)}%).`
          );
        }
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
    } finally {
      decisionSub.dispose();
    }
  }
}

