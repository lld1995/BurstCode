import * as vscode from 'vscode';
import { ChatMessage, OpenAIClient, ToolDef } from '../llm/OpenAIClient';
import { Tool, ToolResult } from './tools/types';
import { FALLBACK_SYSTEM_PROMPT } from './prompts';
import { compressMessages, defaultCompressorConfig, normalizeToolResult, pruneOrphanedToolResults } from '../context/Compressor';
import { estimateMessagesTokens } from '../llm/tokenizer';
import { Logger } from '../util/Logger';
import { extractFirstJsonObject, repairJsonControlChars, repairJsonUnescapedQuotes } from '../util/jsonRepair';
import { HunkApplier } from '../edits/HunkApplier';
import { AskUserFn, salvageProposeEditArgs } from './tools/edits';

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
 * Context-budget awareness tiers, as fractions of the model's context window.
 * The agent has no intrinsic sense of how full its window is, so we feed it a
 * `[context-status]` note whenever usage escalates into a higher tier. This lets
 * the model self-regulate: narrow its read_file line ranges, push broad reading
 * to sub-agents, or proactively compress — instead of blindly dumping whole
 * files until the hard auto-compress at AUTO_COMPRESS_TRIGGER_RATIO kicks in.
 *
 *   tier 1 (>=55%): roomy but be intentional — read tight ranges.
 *   tier 2 (>=72%): tightening — narrow reads, prefer sub-agents, consider compress.
 *   tier 3 (>=85%): critical — auto-compression imminent; stop large reads.
 */
const CONTEXT_STATUS_TIER_RATIOS = [0.55, 0.72, 0.85];

function contextStatusTier(ratio: number): number {
  let tier = 0;
  for (const t of CONTEXT_STATUS_TIER_RATIOS) if (ratio >= t) tier++;
  return tier;
}

function buildContextStatusNote(tier: number, used: number, max: number): string {
  const pct = max > 0 ? Math.round((used / max) * 100) : 0;
  const remaining = Math.max(0, max - used);
  const head =
    `[context-status] Context window ~${pct}% full ` +
    `(${used.toLocaleString()} / ${max.toLocaleString()} tokens; ~${remaining.toLocaleString()} left).`;
  if (tier >= 3) {
    return (
      head +
      ' CRITICAL — automatic compression will trigger soon and may drop detail. ' +
      'Do NOT start new large reads. Finish or narrow the current step. If you still need to read, ' +
      'delegate it to launch_subagent (it reads in its own isolated window; only a summary returns here). ' +
      'If the remaining work is a distinct sub-task, call save_topic_doc then compress_context to reclaim budget.'
    );
  }
  if (tier >= 2) {
    return (
      head +
      ' Budget is tightening — scale down what you pull into context: ' +
      '(1) read NARROW line ranges via read_file (startLine/endLine) instead of whole files; ' +
      '(2) push broad exploration to launch_subagent so raw file content stays out of this window; ' +
      '(3) if the current topic is wrapping up, save_topic_doc then compress_context.'
    );
  }
  return (
    head +
    ' Still roomy, but be intentional from here: read only the line ranges you actually need rather than ' +
    'whole large files, and batch related lookups into one collect_context call instead of many one-off reads.'
  );
}

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

function coerceDsmlParameter(value: string, attrs: Record<string, string>, parseJsonStrings = false): unknown {
  const decoded = decodeDsmlText(value);
  const trimmed = decoded.trim();
  if (attrs.string === 'true' && !parseJsonStrings) return decoded;
  if (!trimmed) return decoded;
  try {
    return JSON.parse(trimmed);
  } catch {
    return decoded;
  }
}

function buildDsmlArguments(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 1) {
    const key = keys[0];
    const value = params[key];
    // Be tolerant of common LLM variants:
    //   <parameter name="json_arg">{"path":"..."}</parameter>
    //   <parameter name="arguments" string="true">{"path":"..."}</parameter>
    // Both should become the tool's argument object, not { json_arg: ... }.
    if ((key === 'json_arg' || key === 'arguments') && value && typeof value === 'object' && !Array.isArray(value)) {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(params);
}

function extractDsmlInvokesFromText(text: string): AccumulatedToolCall[] {
  const calls: AccumulatedToolCall[] = [];
  const dsml = '[|｜]DSML[|｜]';
  const invokeRe = new RegExp(`<${dsml}invoke\\b([^>]*)>([\\s\\S]*?)<\\/${dsml}invoke>`, 'g');
  const paramRe = new RegExp(`<${dsml}parameter\\b([^>]*)>([\\s\\S]*?)<\\/${dsml}parameter>`, 'g');

  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRe.exec(text))) {
    const invokeAttrs = parseDsmlAttributes(invoke[1]);
    const name = invokeAttrs.name;
    if (!name) continue;
    const params: Record<string, unknown> = {};
    paramRe.lastIndex = 0;
    let param: RegExpExecArray | null;
    while ((param = paramRe.exec(invoke[2]))) {
      const paramAttrs = parseDsmlAttributes(param[1]);
      const paramName = paramAttrs.name;
      if (!paramName) continue;
      params[paramName] = coerceDsmlParameter(param[2], paramAttrs, paramName === 'arguments');
    }
    calls.push({ name, arguments: buildDsmlArguments(params) });
  }
  return calls;
}

function extractDsmlToolCalls(text: string): { text: string; calls: AccumulatedToolCall[] } {
  const dsml = '[|｜]DSML[|｜]';
  const blockRe = new RegExp(`<${dsml}tool_calls\\b[^>]*>([\\s\\S]*?)<\\/${dsml}tool_calls>`, 'g');

  const calls = extractDsmlInvokesFromText(text);
  const cleaned = calls.length > 0
    ? text.replace(blockRe, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()
    : text;

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
  // Benign closers that START with an intent-like prefix but are actually a
  // FINISHED answer (offering help, noting a caveat, asking the user to react).
  // These must be excluded first or they false-positive into endless
  // auto-continues even though the task is already complete.
  const benignCloserRe: RegExp[] = [
    /^let me know\b/i,                              // "Let me know if you have questions"
    /^let me explain\b/i,
    /^i('?| a)m\s+going to\s+(?:explain|summari[sz]e|walk)\b/i,
    /^i('?| wi)ll\s+(?:explain|summari[sz]e|note|mention|be here|happily|gladly)\b/i,
    /^i need to (?:note|mention|clarify|point out|flag|highlight)\b/i,
    /^i should (?:note|mention|clarify|point out|flag|highlight)\b/i,
    /^(?:让我知道|让我们|我会(?:在|随时)|我需要(?:说明|指出|提醒|强调)|我将(?:说明|总结))/
  ];
  if (benignCloserRe.some((re) => re.test(last))) return false;
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

/**
 * Detect truncated-request / malformed-body 400 errors that are almost always
 * transient (network proxy cut the POST body mid-flight, HTTP/2 frame limit,
 * reverse-proxy buffering glitch, etc.). Retrying the same request usually
 * succeeds, so we give these a higher auto-resume budget.
 */
function isTruncatedRequestError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  // Python httpparser / json.JSONDecodeError from upstream proxies
  if (msg.includes('unexpected end of data')) return true;
  if (msg.includes('unexpected end of json')) return true;
  // Common variants from nginx, Cloudflare, API gateways
  if (msg.includes('request body incomplete')) return true;
  if (msg.includes('connection reset') && msg.includes('400')) return true;
  return false;
}

const CANCELLED_PROGRESS_TEXT_LIMIT = 18_000;
const CANCELLED_PROGRESS_ARG_LIMIT = 14_000;

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.max(0, Math.floor(max * 0.35));
  const tail = Math.max(0, max - head);
  return (
    text.slice(0, head) +
    `\n... [interrupted progress clipped ${text.length - head - tail} chars; keep the tail as the continuation point] ...\n` +
    text.slice(-tail)
  );
}

function buildInterruptedProgressNote(
  reason: 'cancelled' | 'timeout' | 'stream error',
  assistantText: string,
  reasoningText: string,
  toolCalls: Array<{ index: number; name: string; arguments: string }>,
  salvage: InterruptedProposeEditSalvage = { fragmentCount: 0, fragments: [] }
): string | null {
  const parts: string[] = [];
  if (salvage.fragmentCount > 0) {
    const landed = salvage.fragments
      .map((fragment, i) => {
        const summary = fragment.summary ? ` summary=${JSON.stringify(fragment.summary)}` : '';
        const edits = fragment.edits
          .map((edit, j) => {
            const loc = edit.path
              ? `${edit.path}${edit.startLine !== undefined || edit.endLine !== undefined ? `:${edit.startLine ?? '?'}-${edit.endLine ?? '?'}` : ''}`
              : '(unknown path)';
            const mode = edit.hasOldText ? 'replace-oldText' : 'line-range';
            return `    ${j + 1}. ${loc} (${mode}, oldTextChars=${edit.oldTextChars}, newTextChars=${edit.newTextChars})`;
          })
          .join('\n');
        return `  ${i + 1}. fragment #${fragment.index}${summary}\n${edits}`;
      })
      .join('\n');
    parts.push(
      `${salvage.fragmentCount} complete propose_edit fragment(s) were recovered and applied to disk / pending-edits before resuming. Treat them as committed base work, not draft text.\n` +
      `These landed edits are already part of the live workspace; DO NOT rewrite, re-emit, or replace the same broad ranges again. Continue only the unfinished remainder.\n` +
      `For large changes, resume incrementally: first identify which files/ranges are already landed, then patch only the next missing/incorrect range. If later work depends on landed code, edit around it or make small follow-up corrections instead of regenerating the earlier solution. If you believe a broad rewrite is necessary, STOP and instead read the exact current range plus a small margin, then use oldText or delete_lines to replace/delete only the concrete duplicate/incorrect block.
` +
      `Before any next edit, inspect/read the current live file contents around the remaining target lines and base the change on what is already on disk. Tool reads may be line-windowed/truncated unless they explicitly cover the needed range, so do NOT infer that missing lines from a read result were deleted from the file.
` +
      `Prefer minimal surgical follow-up edits: add missing tail content, modify a small existing block, or delete only duplicated/trailing content. Avoid whole-file or large-range rewrites that overlap the landed fragments; NEVER append a regenerated replacement after already-landed code. If overlap produced duplicates, use delete_lines for the duplicate block or oldText for the exact bad block.
` +
      `If a landed fragment needs adjustment, edit only the smallest affected lines in the current file state; do not regenerate the entire earlier fragment. Large pasted replacement blocks are likely to create duplicate code and file bloat.
` +
      `Landed fragments:\n${landed}`
    );
  }
  const visible = assistantText.trim();
  if (visible) {
    parts.push(
      `Partial assistant text captured before ${reason} (${assistantText.length} chars):\n` +
      clipMiddle(assistantText, CANCELLED_PROGRESS_TEXT_LIMIT)
    );
  }
  if (reasoningText.trim()) {
    parts.push(
      `Partial reasoning was also present (${reasoningText.length} chars; not shown to avoid polluting context).`
    );
  }
  for (const tc of toolCalls) {
    const args = tc.arguments ?? '';
    if (!tc.name && !args.trim()) continue;
    parts.push(
      `Partial tool call #${tc.index}${tc.name ? ` (${tc.name})` : ''} captured before ${reason} ` +
      `(${args.length} arg chars; likely incomplete${salvage.fragmentCount > 0 && tc.name === 'propose_edit' ? ', complete fragments already applied' : ''}, DO NOT execute as-is):\n` +
      clipMiddle(args, CANCELLED_PROGRESS_ARG_LIMIT)
    );
  }
  if (parts.length === 0) return null;
  const lead = reason === 'timeout'
    ? 'timed out after partial output had already streamed'
    : reason === 'stream error'
      ? 'hit a stream error AFTER partial output had already streamed'
      : 'was cancelled/interrupted AFTER partial output had already streamed';
  const continuation = salvage.fragmentCount > 0
    ? `Use the captured progress below to continue from the last coherent point instead of starting over. ` +
      `The listed propose_edit fragments are already on disk/pending review; treat them as the baseline and do not re-emit them or replace the same broad ranges. ` +
      `For large tasks, do not restart the implementation plan from scratch: inspect the current live file contents, decide the smallest next missing/incorrect range, then issue a narrow follow-up edit. ` +
      `If you are tempted to rewrite a large region, do not append/regenerate it; use oldText to replace the exact existing bad block or delete_lines to remove the exact duplicate block. ` +
      `If the landed work made later intended text obsolete or duplicated, delete/adjust only that duplicate tail rather than rewriting the landed block. ` +
      `Remember read results may be partial windows rather than whole files. `
    : `Use the captured progress below to continue from the last coherent point instead of starting over. `;
  return (
    `[interrupted-generation] The previous assistant turn ${lead}. ` +
    continuation +
    `If a partial propose_edit/tool JSON is shown, treat it as a draft only: re-read/retarget against the current file state and issue smaller complete propose_edit calls (prefer one file/hunk at a time). Do not assume a collect_context/read_file slice is the complete file unless the tool output explicitly covers line 1 through the file total or full:true was used.\n\n` +
    parts.join('\n\n')
  );
}

type SalvagedEditFragment = {
  index: string;
  summary?: string;
  edits: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    hasOldText: boolean;
    oldTextChars: number;
    newTextChars: number;
  }>;
};

type InterruptedProposeEditSalvage = {
  fragmentCount: number;
  fragments: SalvagedEditFragment[];
};

function describeSalvagedEditFragment(
  index: string,
  args: Record<string, unknown>,
  edits: unknown[]
): SalvagedEditFragment {
  const summary = typeof args.summary === 'string' ? args.summary : undefined;
  return {
    index,
    summary,
    edits: edits.map((edit) => {
      const rec = edit && typeof edit === 'object' ? edit as Record<string, unknown> : {};
      const startLine = typeof rec.startLine === 'number' ? rec.startLine : undefined;
      const endLine = typeof rec.endLine === 'number' ? rec.endLine : undefined;
      const newText = typeof rec.newText === 'string' ? rec.newText : '';
      const oldText = typeof rec.oldText === 'string' ? rec.oldText : '';
      return {
        path: typeof rec.path === 'string' ? rec.path : undefined,
        startLine,
        endLine,
        hasOldText: oldText.length > 0,
        oldTextChars: oldText.length,
        newTextChars: newText.length
      };
    })
  };
}

/**
 * Land the COMPLETE propose_edit fragments that finished streaming before a
 * stream interruption (network error / timeout). Without this, an interrupted
 * turn discards its whole `toolCallAccumulator` on the next resume attempt, so
 * a fully-written first edit fragment is lost even though it never had a chance
 * to execute — the "stream interrupted before execution, first segment didn't
 * land" bug. We parse each accumulated propose_edit call (normal JSON first,
 * then the truncation-tolerant loose salvage) and run it through the real tool
 * so the complete fragments land on disk + keep their diff preview right away.
 *
 * Re-applying an identical fragment on a later resume attempt is idempotent
 * (HunkApplier resolves a same-range re-issue as last-write-wins), and the
 * `alreadySalvaged` set suppresses needless churn within one resume sequence.
 * Returns the number of fragments applied.
 */
async function salvageInterruptedProposeEdits(
  toolCallAccumulator: Map<number, { id?: string; name: string; arguments: string }>,
  proposeEditTool: Tool | undefined,
  logger: Logger,
  cancellation: vscode.CancellationToken | undefined,
  alreadySalvaged: Set<string>,
  assistantText = ''
): Promise<InterruptedProposeEditSalvage> {
  const result: InterruptedProposeEditSalvage = { fragmentCount: 0, fragments: [] };
  if (!proposeEditTool) return result;
  const candidates: Array<{ idx: string; id?: string; name: string; arguments: string }> = Array.from(toolCallAccumulator.entries())
    .map(([idx, v]) => ({ idx: String(idx), ...v }));
  // Gemini/Bifrost runs use DSML text tool calls instead of native OpenAI tool
  // deltas. On interruption those calls live ONLY in assistantText; the normal
  // successful-stream extraction below has not run yet. Salvage every complete
  // <DSMLinvoke> we can see even if the surrounding <DSMLtool_calls> block or a
  // later invoke was cut off, otherwise the user-visible written fragment never
  // reaches HunkApplier / the pending-edits banner.
  const dsmlCalls = extractDsmlInvokesFromText(assistantText);
  dsmlCalls.forEach((call, i) => candidates.push({ idx: `dsml:${i}`, ...call }));
  for (const v of candidates) {
    if (v.name !== 'propose_edit' || !v.arguments) continue;
    // The call may be COMPLETE even though a LATER chunk in the same stream
    // failed, so try a strict parse before falling back to loose salvage.
    let args: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(v.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to loose salvage */
    }
    if (!args) args = salvageProposeEditArgs(v.arguments);
    if (!args) continue;
    const edits = (args as { edits?: unknown }).edits;
    if (!Array.isArray(edits) || edits.length === 0) continue;
    const sig = `${v.idx}:${JSON.stringify(edits)}`;
    if (alreadySalvaged.has(sig)) continue;
    alreadySalvaged.add(sig);
    try {
      const salvageTokenSource = cancellation?.isCancellationRequested
        ? new vscode.CancellationTokenSource()
        : undefined;
      try {
        const res = await proposeEditTool.execute(args, {
          // Use a fresh token when salvaging after user cancellation. The LLM
          // stream is already stopped, but complete propose_edit fragments that
          // finished streaming before the stop must still hit disk; otherwise the
          // resume prompt can only describe them and the next model turn often
          // rewrites the whole file.
          cancellation: salvageTokenSource?.token ?? cancellation ?? new vscode.CancellationTokenSource().token,
          emitProgress: () => undefined,
          callId: v.id
        });
        if (!res.isError) {
          result.fragmentCount += edits.length;
          result.fragments.push(describeSalvagedEditFragment(v.idx, args, edits));
        }
        logger.warn(
          `Salvaged interrupted propose_edit (call #${v.idx}): ran ${edits.length} complete fragment(s) before resume`
        );
      } finally {
        salvageTokenSource?.dispose();
      }
    } catch (err) {
      logger.warn('Interrupted propose_edit salvage failed', String(err));
    }
  }
  return result;
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

    // ---- context-budget awareness state ----
    // Highest context-status tier the model has already been told about. We only
    // inject a fresh note when usage ESCALATES into a higher tier; when usage
    // drops (e.g. after compression) this tracks back down so a later climb
    // re-notifies. See contextStatusTier / buildContextStatusNote.
    let lastContextStatusTier = 0;

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

      // ── Context-budget awareness ──────────────────────────────────────────
      // Feed the model a compact status note whenever usage escalates into a
      // higher tier, so it can self-regulate read granularity / offload to
      // sub-agents / compress — rather than reading blindly until the hard
      // auto-compress above fires. Escalation-only (tier must increase) keeps
      // this from spamming context every turn; the tier tracks back down with
      // usage so a later climb re-notifies.
      const ctxStatusTier = ctxMax > 0 ? contextStatusTier(usedTokens / ctxMax) : 0;
      if (ctxStatusTier > lastContextStatusTier) {
        messages.push({
          role: 'user',
          content: buildContextStatusNote(ctxStatusTier, usedTokens, ctxMax)
        });
        this.logger.info(
          `Context-status note injected: tier ${ctxStatusTier} ` +
            `(${((usedTokens / ctxMax) * 100).toFixed(1)}% of ${ctxMax} tokens).`
        );
        // Re-measure so the gauge below reflects the appended note.
        usedTokens = estimateMessagesTokens(messages as Array<{ role: string; content: unknown }>);
      }
      lastContextStatusTier = ctxStatusTier;

      yield {
        type: 'context-usage',
        payload: { used: usedTokens, max: ctxMax }
      };

      let assistantText = '';
      let reasoningText = '';
      const toolCallAccumulator = new Map<
        number,
        { id?: string; name: string; arguments: string }
      >();
      const preAnnounced = new Set<number>();
      const argDeltaBuffers = new Map<string, { id?: string; text: string }>(); // idx -> buffered arg text + current tool-call id
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
      // Tracks propose_edit fragments already landed by the interruption-salvage
      // pass so the same fragment is not re-applied on every resume attempt of
      // this turn. Re-declared per outer iteration so a deliberate re-issue in a
      // later turn is never blocked.
      const salvagedInterruptedEdits = new Set<string>();
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
        const compressed = compressMessages(messages, {
          ...defaultCompressorConfig,
          contextWindow: this.options.contextWindow,
          inputBudgetRatio: 0.6,
          keepLastN: 1
        });
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
              if (chunk.toolCallDelta.id && !entry.id) entry.id = chunk.toolCallDelta.id;
              if (chunk.toolCallDelta.name) entry.name = chunk.toolCallDelta.name;
              if (chunk.toolCallDelta.argumentsDelta) entry.arguments += chunk.toolCallDelta.argumentsDelta;
              toolCallAccumulator.set(idx, entry);
              // Pre-announce: emit tool-call-start as soon as the tool NAME is known.
              // Do NOT require entry.id — many OpenAI-compatible models omit id from
              // streaming deltas and only set it in the final assistant message.
              if (!preAnnounced.has(idx) && entry.name) {
                preAnnounced.add(idx);
                // Many OpenAI-compatible models omit id from streaming deltas.
                // Generate a stable id now and store it back so the subsequent
                // tool-call-start (update) and tool-call-end events share the
                // same id — otherwise the webview creates duplicate elements
                // and the streaming one stays "running" forever.
                if (!entry.id) {
                  entry.id = `call_${Date.now()}_${idx}`;
                  toolCallAccumulator.set(idx, entry);
                }
                yield { type: 'tool-call-start', payload: { name: entry.name, id: entry.id, args: {}, streaming: true } };
              }
              // Stream argument text to UI. Use idx (stable integer index) as the
              // buffer key so we don't need entry.id, which may be absent.
              if (preAnnounced.has(idx) && chunk.toolCallDelta.argumentsDelta) {
                const bufKey = String(idx);
                const prev = argDeltaBuffers.get(bufKey);
                const next = (prev?.text ?? '') + chunk.toolCallDelta.argumentsDelta;
                if (next.length >= 40) {
                  argDeltaBuffers.set(bufKey, { id: entry.id, text: '' });
                  yield { type: 'tool-call-args-delta', payload: { id: entry.id, delta: next } };
                } else {
                  argDeltaBuffers.set(bufKey, { id: entry.id, text: next });
                }
              }
            }
            if (chunk.finishReason) finishReason = chunk.finishReason;
          }
          if (cancellation.isCancellationRequested) {
            const interruptedToolCalls = Array.from(toolCallAccumulator.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([index, v]) => ({ index, name: v.name, arguments: v.arguments }));
            const salvage = await salvageInterruptedProposeEdits(
              toolCallAccumulator,
              runToolMap.get('propose_edit'),
              this.logger,
              cancellation,
              salvagedInterruptedEdits,
              assistantText
            );
            const progressNote = buildInterruptedProgressNote(
              'cancelled',
              assistantText,
              reasoningText,
              interruptedToolCalls,
              salvage
            );
            if (progressNote) messages.push({ role: 'user', content: progressNote });
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          streamOk = true;
          // Flush any buffered arg delta text that didn't reach the 40-char threshold.
          // Keep the generated per-call id so multiple simultaneous streamed tool calls
          // do not route their tail fragments to the last active tool card.
          for (const [, buf] of argDeltaBuffers) {
            if (buf.text) yield { type: 'tool-call-args-delta', payload: { id: buf.id, delta: buf.text } };
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
            const interruptedToolCalls = Array.from(toolCallAccumulator.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([index, v]) => ({ index, name: v.name, arguments: v.arguments }));
            const salvage = await salvageInterruptedProposeEdits(
              toolCallAccumulator,
              runToolMap.get('propose_edit'),
              this.logger,
              cancellation,
              salvagedInterruptedEdits,
              assistantText
            );
            const progressNote = buildInterruptedProgressNote(
              'cancelled',
              assistantText,
              reasoningText,
              interruptedToolCalls,
              salvage
            );
            if (progressNote) messages.push({ role: 'user', content: progressNote });
            yield { type: 'done', payload: { reason: 'cancelled' } };
            return;
          }
          // Stream interrupted (network error / timeout) AFTER one or more
          // propose_edit fragments had already finished streaming. Land those
          // COMPLETE fragments on disk now — before the accumulator is discarded
          // on the next resume attempt — so a fully-written first segment is no
          // longer lost just because a later segment's stream was cut. Idempotent
          // across resume attempts via `salvagedInterruptedEdits`.
          let salvage: InterruptedProposeEditSalvage = { fragmentCount: 0, fragments: [] };
          try {
            salvage = await salvageInterruptedProposeEdits(
              toolCallAccumulator,
              runToolMap.get('propose_edit'),
              this.logger,
              cancellation,
              salvagedInterruptedEdits,
              assistantText
            );
            if (salvage.fragmentCount > 0) {
              this.logger.warn(
                `Stream interrupted mid-propose_edit: salvaged ${salvage.fragmentCount} complete fragment(s) onto disk before resume`
              );
            }
          } catch (salvageErr) {
            this.logger.warn('Interrupted propose_edit salvage pass failed', String(salvageErr));
          }
          const interruptedToolCalls = Array.from(toolCallAccumulator.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([index, v]) => ({ index, name: v.name, arguments: v.arguments }));
          const progressNote = buildInterruptedProgressNote(
            String(err).includes(`LLM stream timed out after ${STREAM_TIMEOUT_MS}ms`) ? 'timeout' : 'stream error',
            assistantText,
            reasoningText,
            interruptedToolCalls,
            salvage
          );
          if (progressNote) messages.push({ role: 'user', content: progressNote });
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
          // Truncated-request errors ("unexpected end of data") are almost always
          // transient network-level issues — a proxy, load balancer, or HTTP/2
          // frame limit cut the POST body mid-flight. Retrying usually succeeds,
          // so we grant extra auto-resume attempts beyond the normal budget.
          const truncated = isTruncatedRequestError(err);
          const effectiveMax = truncated ? maxResumes + 3 : maxResumes;
          if (resumeAttempt >= effectiveMax) {
            this.logger.error('LLM stream error', String(err));
            const detail = String(err);
            const suffix =
              resumeAttempt > 0
                ? ` (after ${resumeAttempt} auto-resume${resumeAttempt === 1 ? '' : 's'})`
                : '';
            const hint = truncated
              ? ' The upstream server received an incomplete request body (network truncation). ' +
                'If this persists, check your network/proxy settings or try a shorter conversation.'
              : '';
            yield { type: 'error', payload: `Stream interrupted${suffix}: ${detail}${hint}` };
            return;
          }
          resumeAttempt++;
          const delayMs = Math.min(500 * 2 ** (resumeAttempt - 1), 4000);
          const reason = truncated ? 'truncated request body (network)' : 'stream error';
          this.logger.warn(
            `LLM stream interrupted — ${reason} (attempt ${resumeAttempt}/${effectiveMax}); resuming in ${delayMs}ms: ${String(err)}`
          );
          yield {
            type: 'auto-resume',
            payload: {
              attempt: resumeAttempt,
              max: effectiveMax,
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
        if (!tc.name) {
          if (preAnnounced.has(i)) {
            yield { type: 'tool-call-end', payload: { name: '', id: finalCalls[i]?.id, result: '[stream truncated — tool call discarded]', isError: true } };
          }
          continue;
        }
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
              // Final fallback: the model sometimes concatenates TWO tool-call
              // argument objects into one string ("{...}{...}"), which trips
              // JSON.parse with "Unexpected non-whitespace character after JSON".
              // Honor the FIRST complete object so the call still runs and the
              // conversation isn't dead-ended on a parse error it keeps repeating.
              if (parseError) {
                const firstObj = extractFirstJsonObject(afterControl);
                if (firstObj !== null) {
                  try {
                    parsed = JSON.parse(firstObj);
                    parseError = undefined;
                    this.logger.warn(
                      `Tool args ${tc.name}: recovered first of multiple concatenated JSON objects (trailing content discarded)`
                    );
                  } catch { /* keep the original parseError */ }
                }
              }
              // propose_edit-specific salvage: when the args are TRUNCATED
              // mid-stream (model ran out of output budget), the generic
              // repairs above cannot help because there is no complete object
              // to parse. Recover whatever WHOLE edit fragments DID arrive so
              // they still land on disk and keep their diff preview — the
              // "write one fragment, land one fragment" guarantee survives even
              // a cut-off tool call. The half-written tail fragment is dropped
              // and the tool tells the model to re-issue the remaining edits.
              if (parseError && tc.name === 'propose_edit') {
                const salvaged = salvageProposeEditArgs(afterControl);
                if (salvaged) {
                  parsed = salvaged;
                  parseError = undefined;
                  this.logger.warn(
                    `Tool args propose_edit: salvaged ${(salvaged.edits as unknown[]).length} complete edit fragment(s) from truncated args`
                  );
                }
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

      // Helper to emit a single tool-call-start event lazily (when the tool
      // actually begins executing, not all at once upfront). This way the UI
      // correctly reflects serialization: unsafe tools show as "running" only
      // after prior parallel-safe batches have completed.
      const emitStart = (c: PreparedCall) => {
        // Avoid double-emitting for tools already pre-announced during streaming.
        if (preAnnounced.has(c.index)) return;
        preAnnounced.add(c.index);
        return { type: 'tool-call-start' as const, payload: { name: c.name, args: c.parsed, id: c.callId, update: false } };
      };

      const executeOne = async (c: PreparedCall): Promise<ToolResult> => {
        if (!c.tool) {
          const ccHints: Record<string, string> = { greps: 'grep_search', reads: 'read_file', lists: 'list_dir', outlines: 'workspace_outline', searches: 'grep_search', files: 'read_file', dirs: 'list_dir', trees: 'workspace_outline' };
          const ccParamNames: Record<string, string> = { greps: 'searches', reads: 'files', lists: 'dirs', outlines: 'trees', searches: 'searches', files: 'files', dirs: 'dirs', trees: 'trees' };
          const standalone = ccHints[c.name];
          const paramName = ccParamNames[c.name];
          const hint = standalone
            ? ` '${c.name}' is a PARAMETER of collect_context, NOT a standalone tool. Call '${standalone}' directly, or use collect_context({ "${paramName}": [...] }).`
            : '';
          return { content: `Unknown tool: ${c.name}.${hint}`, isError: true };
        }
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
          let toolTokenSource: vscode.CancellationTokenSource | undefined;
          try {
            // Once a propose_edit call has fully streamed, cancellation should not
            // prevent it from landing on disk. The user's stop request only aborts
            // further LLM generation; already-complete edit fragments must still be
            // applied so resume does not rewrite the whole file.
            if (c.name === 'propose_edit') {
              toolTokenSource = new vscode.CancellationTokenSource();
            }
            return await c.tool.execute(c.parsed, {
              cancellation: toolTokenSource?.token ?? cancellation,
              callId: c.callId,
              emitProgress: (message: string) => {
                progressQueue.push({ callId: c.callId, name: c.name, message });
                const r = resolveWaiter;
                resolveWaiter = null;
                r?.();
              }
            });
          } finally {
            toolTokenSource?.dispose();
          }
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

      const executeUnrunProposeEditsAfterCancellation = async (fromIndex: number): Promise<Array<{ name: string; id: string; args: Record<string, unknown>; result: ToolResult }>> => {
        const landed: Array<{ name: string; id: string; args: Record<string, unknown>; result: ToolResult }> = [];
        for (let i = fromIndex; i < prepared.length; i++) {
          const c = prepared[i];
          if (results[i] !== undefined || c.name !== 'propose_edit' || !c.tool || c.parseError) continue;
          const tokenSource = new vscode.CancellationTokenSource();
          try {
            const result = await c.tool.execute(c.parsed, {
              cancellation: tokenSource.token,
              callId: c.callId,
              emitProgress: () => undefined
            });
            results[i] = result;
            landed.push({ name: c.name, id: c.callId, args: c.parsed, result });
            this.logger.warn(
              `Cancellation occurred before tool execution; forced propose_edit ${c.callId} to disk before stopping`
            );
          } catch (err) {
            const result: ToolResult = { content: `Tool error while salvaging cancelled propose_edit: ${String(err)}`, isError: true };
            results[i] = result;
            landed.push({ name: c.name, id: c.callId, args: c.parsed, result });
          } finally {
            tokenSource.dispose();
          }
        }
        return landed;
      };

      // Walk the prepared list, grouping contiguous parallel-safe calls into
      // batches that are executed concurrently. Unsafe tools (ask_user,
      // update_plan, record_lesson, run_shell, ...) run alone and in order
      // so their UI / shared-state side effects stay deterministic.
      // propose_edit is parallel-safe: HunkApplier serializes per-file
      // mutations internally, so concurrent file writes do queue up safely.
      let cursor = 0;
      while (cursor < prepared.length) {
        if (cancellation.isCancellationRequested) {
          const landed = await executeUnrunProposeEditsAfterCancellation(cursor);
          for (const item of landed) {
            yield {
              type: 'tool-call-end',
              payload: { name: item.name, id: item.id, args: item.args, result: item.result.content, isError: !!item.result.isError, meta: item.result.meta }
            };
          }
          break;
        }
        if (isUnsafe(prepared[cursor])) {
          const c = prepared[cursor];
          // Emit start lazily — only now that this tool is actually beginning.
          const se = emitStart(c);
          if (se) yield se;
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
            payload: { name: c.name, id: c.callId, args: c.parsed, result: result.content, isError: !!result.isError, meta: result.meta }
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
          // Emit start lazily for each tool in the parallel batch.
          const se = emitStart(prepared[absIdx]);
          if (se) yield se;
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
          if (cancellation.isCancellationRequested) {
            const landed = await executeUnrunProposeEditsAfterCancellation(batchStart);
            for (const item of landed) {
              yield {
                type: 'tool-call-end',
                payload: { name: item.name, id: item.id, args: item.args, result: item.result.content, isError: !!item.result.isError, meta: item.result.meta }
              };
            }
            batchSettled = true;
            break;
          }
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
              payload: { name: c.name, id: c.callId, args: c.parsed, result: res.content, isError: !!res.isError, meta: res.meta }
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
                payload: { name: c.name, id: c.callId, args: c.parsed, result: results[absIdx].content, isError: true, meta: undefined }
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
        // EVERY tool_call id declared on the assistant message MUST get a
        // matching `tool` reply, otherwise the next request carries a dangling
        // tool_use/tool_result pair and Anthropic-style backends reject it with
        //   400 unexpected `tool_use_id` ... each `tool_result` must have a
        //   corresponding `tool_use` block in the previous message.
        // When a batch is cancelled mid-flight `results[i]` is undefined — push
        // a synthetic reply so the pairing in the PERSISTENT history stays
        // valid (the request-time sanitizer in OpenAIClient is the safety net,
        // but keeping the stored array consistent avoids relying on it).
        const storedContent = result
          ? normalizeToolResult(c.name, result.content)
          : 'Tool call was cancelled before it produced a result.';
        messages.push({
          role: 'tool',
          tool_call_id: c.callId,
          content: storedContent
        } as ChatMessage);
      }

      // Context-budget awareness is handled at the next iteration boundary (see
      // contextStatusTier / buildContextStatusNote above), where post-tool usage
      // is freshly measured and a tiered `[context-status]` note is injected on
      // escalation — superseding the old one-shot read-count offload hint.

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

