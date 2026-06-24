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
 * Tools whose results must not be zone-truncated. These are structural reads
 * (symbol outlines, reference lists) that the model needs intact for as long as
 * the file is being worked on — orphan pruning already removes them once they
 * are no longer referenced downstream. Consistent with normalizeToolResult which
 * also applies no storage-time cap for the same tools.
 */
const NO_ZONE_TRUNCATE_TOOLS = new Set([
  'document_symbols',
  'workspace_symbols',
  'find_references',
  'find_references_by_name',
  'find_implementations',
  'find_definition',
]);

/**
 * Layered compression strategy:
 *  1. Always keep system message + last `keepLastN` exchanges in full (zone 0).
 *  2. Unconditionally compress older tool/assistant content by zone (distance-based).
 *  3. Budget-overflow: drop oldest non-system messages as a last resort.
 */
export function compressMessages(messages: ChatMessage[], cfg: CompressorConfig): ChatMessage[] {
  const result = [...messages];
  const systemIdx = result.findIndex((m) => m.role === 'system');

  // Build a tool_call_id → tool name map so Pass 1 can exempt structural reads
  // (document_symbols, workspace_symbols, LSP tools) from zone truncation.
  const callIdToName = new Map<string, string>();
  for (const m of result) {
    const calls = (m as { tool_calls?: Array<{ id: string; function: { name: string } }> }).tool_calls;
    if (calls) {
      for (const c of calls) callIdToName.set(c.id, c.function.name);
    }
  }

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
      const hasToolCalls = Array.isArray(am.tool_calls) && am.tool_calls.length > 0;
      let mutated: Mut | null = null;
      // Strip replayed chain-of-thought ONLY on plain-answer turns. Assistant
      // messages that carry tool_calls must KEEP their reasoning_content: the
      // DeepSeek thinking models require the chain-of-thought to be passed back
      // on every tool-call turn that remains in history, or the next request
      // 400s with "The `reasoning_content` in the thinking mode must be passed
      // back to the API." (DeepSeek ignores reasoning on non-tool turns, so
      // dropping it there is both safe and the documented behaviour.) Without
      // this guard a tool-call turn loses its reasoning the moment it ages past
      // zone 0 — e.g. after a second user turn or any synthetic user message the
      // agent loop injects mid-run (stuck-detector, premature-stop, …).
      if (!hasToolCalls && typeof am.reasoning_content === 'string' && am.reasoning_content.length > 0) {
        mutated = { ...am, reasoning_content: '' };
      }
      if (hasToolCalls && am.tool_calls) {
        const toolCalls = am.tool_calls;
        const argsCap = ZONE_CAPS[zone];
        const trimmed = toolCalls.map((tc) => {
          const argStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
          if (argStr.length <= argsCap) return tc;
          // Keep arguments as valid JSON to satisfy strict server validators,
          // but use an explicit "_elided" marker (NOT a plausible field like a
          // truncated value) so the model never mistakes this historical
          // placeholder for an imitable argument shape. Imitation of the old
          // `{_truncated: "N chars"}` placeholder was causing the very next
          // propose_edit to emit `{_truncated: ...}` as its real args and fail.
          const placeholder = JSON.stringify({
            _elided: `[${tc.function.name || 'tool'} args elided by history compaction \u2014 ${argStr.length} chars. This is a PAST call's record, not a template. Re-issue real arguments if calling again.]`
          });
          return { ...tc, function: { ...tc.function, arguments: placeholder } };
        });
        const anyChanged = trimmed.some((tc, idx) => tc !== toolCalls[idx]);
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
    // Skip zone truncation for structural tool results (symbol outlines, LSP
    // references). Orphan pruning handles their eventual removal; truncating
    // them mid-conversation destroys the model's orientation in the file.
    if (msg.role === 'tool') {
      const id = (msg as ChatMessage & { tool_call_id?: string }).tool_call_id ?? '';
      if (NO_ZONE_TRUNCATE_TOOLS.has(callIdToName.get(id) ?? '')) continue;
    }
    let original = stringifyContent(msg.content);
    // For older `read_file` replies, the `   123\t` line-number prefix on
    // every line is dead weight — the model only needs current line numbers
    // when it's about to propose_edit, which only happens off the LATEST
    // read_file (zone 0). Stripping the prefix here roughly halves the byte
    // cost of historical file reads, leaving more headroom under the cap.
    if (msg.role === 'tool') {
      original = stripReadFileLineNumbers(original);
    }
    if (original.length <= cap) {
      // Even if we're under the cap, persist the prefix-stripped version
      // so the savings stick across subsequent compressMessages passes.
      if (original !== stringifyContent(msg.content)) {
        result[i] = { ...msg, content: original } as ChatMessage;
      }
      continue;
    }
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
 * Strip ANSI / terminal escape sequences. Build tools (npm, cargo, dotnet,
 * webpack, ...) emit colour codes and cursor-control bytes that are pure
 * noise once the output is text in a model prompt.
 */
function stripAnsi(text: string): string {
  // CSI sequences (colour, cursor moves), OSC titles, and bare ESC bytes.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\]\d+;[^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[@-_]/g, '');
}

/**
 * Collapse carriage-return progress bars / spinners (npm, pip, cargo, ...)
 * to just their final state, then drop near-duplicate consecutive progress
 * lines that bloat tool output without adding signal.
 */
function collapseProgressNoise(text: string): string {
  // Each \r-segment is a redraw of the same line; only the last one matters.
  const collapsed = text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
  // Drop ASCII progress bars like "[=====>       ] 42%" — they convey 0 info
  // once the build finished.
  return collapsed.replace(/^\s*\[[=>\- .]+\]\s*\d*%?.*$/gm, '');
}

/**
 * Strip the `   123\t` line-number prefix produced by `read_file` (see
 * `buildReadFileTool` in src/agent/tools/core.ts). The prefix is critical
 * for the model to address ranges in propose_edit, but only on the LATEST
 * read_file output — historical reads in older zones don't need it, so we
 * cut ~6 chars per line to free room for actual code under the zone cap.
 *
 * Detection is shape-based (no tool_name on the message) — we only strip
 * when the content starts with the unmistakable `# <path> (lines N-M of K)`
 * header that read_file always emits.
 */
function stripReadFileLineNumbers(content: string): string {
  if (!/^# .* \(lines \d+-\d+ of \d+\)/.test(content)) return content;
  return content.replace(/^ {0,4}\d+\t/gm, '');
}

/** Head + tail truncation; keeps both ends because shell errors usually
 * surface in the LAST 1-2 KB while context lives in the first. */
function truncateMiddle(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars + 80) return text;
  const omitted = text.length - headChars - tailChars;
  return (
    text.slice(0, headChars) +
    `\n...[${omitted} chars elided from middle]...\n` +
    text.slice(-tailChars)
  );
}

/**
 * Compress one of the `## stdout` / `## stderr` sections inside a run_shell
 * result body. Strips ANSI, collapses progress lines, then head/tail-caps.
 * Empty bodies (the literal "(empty)" sentinel) are returned as-is so the
 * caller can drop the whole section.
 */
function compressShellSection(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '' || trimmed === '(empty)') return '(empty)';
  // Normalise Windows CRLF → LF before further processing.
  // collapseProgressNoise splits on \n then keeps only the text after the last
  // \r in each line (to handle carriage-return progress redraws). cmd.exe /
  // Win32 programs (ipconfig, netstat, …) use \r\n line endings, so without
  // normalisation every single line ends with \r → the post-\r part is ""
  // → the entire section is silently wiped.
  const lf = body.replace(/\r\n/g, '\n');
  const cleaned = collapseProgressNoise(stripAnsi(lf)).replace(/\n{3,}/g, '\n\n');
  // 20 000 chars ≈ 250 lines — covers the vast majority of build/test outputs
  // without truncation. For longer outputs keep the first 4 000 (context /
  // command echo) and last 12 000 (errors and results always live in the tail).
  if (cleaned.length <= 20000) return cleaned;
  return truncateMiddle(cleaned, 4000, 12000);
}

/**
 * Normalize a raw tool result string before storing it in the messages array.
 * Applies tool-type-specific reductions so the stored content is already lean
 * before the compressor ever sees it.
 */
export function normalizeToolResult(toolName: string, content: string): string {
  // Nothing to compress
  if (content.length < 200) return content;

  // grep_search: no storage-time cap; zone compression handles old results.
  if (toolName === 'grep_search') {
    return content;
  }

  // read_file: no storage-time cap. The tool itself limits output to at most
  // endLine-startLine+1 lines (default 200); zone compression in compressMessages
  // handles truncating stale reads. Capping here would hide content from the
  // model even on the current turn, which breaks large-file editing.
  if (toolName === 'read_file') {
    return content;
  }

  // list_dir / workspace_outline: no storage-time cap.
  if (toolName === 'list_dir' || toolName === 'workspace_outline') {
    return content;
  }

  // run_shell: the biggest single source of tool_result noise. We:
  //   1. Strip ANSI colour codes and OSC sequences.
  //   2. Collapse \r-style progress redraws / ASCII progress bars.
  //   3. Drop the whole `## stdout` or `## stderr` section when it's empty.
  //   4. Head+tail-cap each non-empty section at ~2700 chars (errors usually
  //      live in the tail, command echo in the head).
  if (toolName === 'run_shell') {
    // Body layout produced by shell.ts: header lines starting with `#`,
    // blank line, then alternating `## stdout` / `## stderr` sections.
    // NB: $(?![\s\S]) instead of bare $ — with the /m flag, plain $ also
    // matches before every \n, so the lazy [\s\S]*? terminates at the first
    // newline (which is the blank line shell.ts emits right after the section
    // header) and the capture group returns empty. The negative lookahead
    // forces $ to mean "true end of string" only.
    const stdoutMatch = content.match(/^## stdout[^\n]*\n([\s\S]*?)(?=\n## stderr|$(?![\s\S]))/m);
    const stderrMatch = content.match(/^## stderr[^\n]*\n([\s\S]*?)$(?![\s\S])/m);
    if (!stdoutMatch && !stderrMatch) {
      // Unknown shape — fall back to a generic head+tail cap.
      return content.length > 4000 ? truncateMiddle(content, 2000, 1500) : content;
    }
    const headerEnd = stdoutMatch ? stdoutMatch.index ?? 0 : stderrMatch ? stderrMatch.index ?? 0 : 0;
    const header = content.slice(0, headerEnd).replace(/\n+$/, '');
    const sections: string[] = [header];
    if (stdoutMatch) {
      const body = compressShellSection(stdoutMatch[1] ?? '');
      if (body !== '(empty)') sections.push(`## stdout\n${body}`);
    }
    if (stderrMatch) {
      const body = compressShellSection(stderrMatch[1] ?? '');
      if (body !== '(empty)') sections.push(`## stderr\n${body}`);
    }
    return sections.join('\n\n');
  }

  // LSP reference / implementation tools: no storage-time cap.
  if (
    toolName === 'find_references' ||
    toolName === 'find_references_by_name' ||
    toolName === 'find_implementations' ||
    toolName === 'find_definition'
  ) {
    return content;
  }

  // workspace_symbols / document_symbols: no storage-time cap.
  if (toolName === 'workspace_symbols' || toolName === 'document_symbols') {
    return content;
  }

  // hover_info: squeeze consecutive blank lines but no hard cap.
  if (toolName === 'hover_info') {
    return content.replace(/\n{3,}/g, '\n\n');
  }

  // launch_subagent: concatenated per-task reports; keep head + tail so the
  // overall summary AND the final task's conclusion survive.
  if (toolName === 'launch_subagent') {
    if (content.length > 8000) {
      return truncateMiddle(content, 4500, 3000);
    }
    return content;
  }

  // get_function_range: no storage-time cap, same rationale as read_file above.
  if (toolName === 'get_function_range') {
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

// ---------------------------------------------------------------------------
// Orphan-prune pass
// ---------------------------------------------------------------------------

/**
 * Tool names whose results are purely "exploratory reads" — they are safe to
 * prune once we can prove they are no longer referenced by later messages.
 * Results from write/action/UI tools (propose_edit, run_shell, ask_user, …)
 * are intentionally excluded: those carry decision history that the model
 * may still need even if no file path appears downstream.
 */
const PRUNABLE_TOOLS = new Set([
  'read_file',
  'collect_context',
  'grep_search',
  'workspace_outline',
  'list_dir',
  'document_symbols',
  'workspace_symbols',
  'find_references',
  'find_references_by_name',
  'find_implementations',
  'find_definition',
  'hover_info',
  'get_function_range',
]);

/**
 * Extract file-path-like tokens from a tool result string so we can check
 * whether those paths appear in later messages.
 *
 * Strategy per tool:
 *  - read_file / get_function_range: the header `# <path> (lines …)` is canonical.
 *  - collect_context: section headers `===== read_file <path> … =====`.
 *  - grep_search: leading `<path>:<line>:` tokens.
 *  - everything else: generic path heuristic (word chars + separators + extension).
 *
 * Returns an empty set when no paths can be reliably extracted (→ no prune).
 */
function extractPathsFromToolResult(toolName: string, content: string): Set<string> {
  const paths = new Set<string>();

  if (toolName === 'read_file') {
    // Header: `# src/agent/AgentLoop.ts (lines 1-200 of 1201)`
    const m = content.match(/^# (.+?) \(lines \d/);
    if (m) paths.add(m[1].trim());
    return paths;
  }

  if (toolName === 'get_function_range') {
    // Header: `# Method run [311-1287]` — `# <SymbolKind> <name> [start-end]`.
    // There is NO path here, so we use the symbol NAME as the reference token:
    // if the name no longer appears downstream the body is safe to prune.
    // (Previously this shared read_file's `(lines …)` regex, which never matched
    //  this header → the set was always empty → the body was never pruned.)
    const m = content.match(/^# \S+ (\S+) \[\d+-\d+\]/);
    if (m) paths.add(m[1].trim());
    return paths;
  }

  if (toolName === 'collect_context') {
    // Section headers: `===== read_file src/foo/bar.ts:10-50 =====`
    //                  `===== grep_search someQuery [**/*.ts] =====`
    // We only care about tokens that look like file paths (contain / or \ and a dot).
    const sectionRe = /={5} \S+ (\S+)/g;
    let sm: RegExpExecArray | null;
    while ((sm = sectionRe.exec(content)) !== null) {
      const token = sm[1].split(':')[0]; // strip :lineNo suffix
      if (/[\/\\]/.test(token) && /\.\w+$/.test(token)) {
        paths.add(token);
      }
    }
    // Also pick up `# path (lines …)` headers inside the sections.
    const headerRe = /^# (.+?) \(lines \d/gm;
    let hm: RegExpExecArray | null;
    while ((hm = headerRe.exec(content)) !== null) {
      paths.add(hm[1].trim());
    }
    // IMPORTANT: collect_context can embed grep_search sub-results whose bodies
    // are `src/foo/bar.ts:42:3:code` lines. Those paths live neither in the
    // section header (which holds the query, not a path) nor in a `# path`
    // header, so without this pass they'd be invisible to the prune guard and
    // the result could be wrongly deleted while still referenced downstream.
    // Reuse the same grep line heuristic to capture them.
    const grepLineRe = /^((?:[A-Za-z]:[\\/])?[\w./\\][\w./\\-]+\.\w+):\d+:/gm;
    let glm: RegExpExecArray | null;
    while ((glm = grepLineRe.exec(content)) !== null) {
      paths.add(glm[1]);
    }
    return paths;
  }

  if (toolName === 'grep_search') {
    // Match lines: `src/foo/bar.ts:42:  code` (relative) or
    //              `e:\project\src\foo.ts:42:3:code` (Windows absolute, drive
    //              letter prefix). The optional `[A-Za-z]:[\\/]` head is required
    //              so the drive-letter colon isn't mistaken for the line-number
    //              separator (which previously truncated the path at `e`).
    const lineRe = /^((?:[A-Za-z]:[\\/])?[\w./\\][\w./\\-]+\.\w+):\d+:/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(content)) !== null) {
      paths.add(lm[1]);
    }
    return paths;
  }

  // Generic: scan for anything that looks like a relative file path.
  // Require at least one / or \ separator and a file extension to avoid
  // false positives on short identifiers.
  const genericRe = /(?:^|\s|["'`(])([\w][\w./\\-]*\/[\w./\\-]+\.\w{1,6})(?:\s|["'`),:]|$)/gm;
  let gm: RegExpExecArray | null;
  while ((gm = genericRe.exec(content)) !== null) {
    paths.add(gm[1]);
  }
  return paths;
}

/**
 * Build a single string containing all downstream message content
 * (from index `fromIdx` to end) for fast path-presence checks.
 */
function buildDownstreamText(messages: ChatMessage[], fromIdx: number): string {
  const parts: string[] = [];
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i];
    parts.push(stringifyContent(m.content));
    // Also scan tool_call arguments on assistant messages (propose_edit path/oldText).
    const calls = (m as { tool_calls?: Array<{ function: { arguments: string } }> }).tool_calls;
    if (calls) {
      for (const c of calls) parts.push(c.function.arguments ?? '');
    }
  }
  // Normalize path separators so Windows absolute paths (`e:\\project\\src\\foo.ts`
  // in JSON-encoded args, or `e:\project\src\foo.ts` in raw content) still match
  // relative forward-slash paths extracted from tool result headers (`src/foo.ts`).
  // Two-pass: first collapse JSON-escaped double backslashes, then remaining singles.
  const joined = parts.join('\n');
  return joined.replace(/\\\\/g, '/').replace(/\\/g, '/');
}

/**
 * Walk the messages array and collapse tool results that are safe to prune.
 *
 * A tool result at index `i` is prunable when ALL of the following hold:
 *   1. Its tool name is in PRUNABLE_TOOLS.
 *   2. It is NOT in the protected zone (last keepLastN exchanges).
 *   3. The content is longer than MIN_PRUNE_CHARS (not already tiny).
 *   4. Every file path extracted from its content does NOT appear anywhere
 *      in the messages that come AFTER it (i+1 … end).
 *      → If even one path still appears downstream, the result is kept intact
 *        because the model may still need it for propose_edit or a follow-up read.
 *
 * Pruned content is replaced with a one-line sentinel:
 *   `[pruned: <toolName> <primary-path-or-summary> — not referenced in later turns]`
 * The message itself is kept so tool pairing (assistant ↔ tool) stays valid.
 *
 * Returns the number of messages pruned (for logging).
 */
export function pruneOrphanedToolResults(
  messages: ChatMessage[],
  keepLastN: number,
  /**
   * Recent-read grace period: the most recent `graceRecentToolResults` PRUNABLE
   * tool results are kept intact even when their paths are absent downstream.
   * The model very often returns to the same file a few turns later to issue a
   * propose_edit; deleting a just-read result forces a wasteful re-read. Set to
   * 0 to disable the grace window (legacy aggressive behaviour).
   */
  graceRecentToolResults = 0
): number {
  const MIN_PRUNE_CHARS = 300;

  // Determine the protected boundary (last keepLastN exchanges from the end).
  // An "exchange" boundary is a user message; we count back keepLastN of them.
  let protectedFrom = messages.length;
  let exchangeCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      exchangeCount++;
      if (exchangeCount >= keepLastN) {
        protectedFrom = i;
        break;
      }
    }
  }

  // Build a name-lookup from tool_call_id → tool name using assistant messages.
  const callIdToName = new Map<string, string>();
  for (const m of messages) {
    const calls = (m as { tool_calls?: Array<{ id: string; function: { name: string } }> }).tool_calls;
    if (calls) {
      for (const c of calls) callIdToName.set(c.id, c.function.name);
    }
  }

  // Compute the boundary for the recent-read grace window: any prunable tool
  // result at index >= graceFrom is considered "recently read" and exempt. Walk
  // backwards collecting prunable tool-result indices until we have
  // `graceRecentToolResults` of them; the earliest one becomes the boundary.
  let graceFrom = messages.length;
  if (graceRecentToolResults > 0) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0 && seen < graceRecentToolResults; i--) {
      const m = messages[i];
      if (m.role !== 'tool') continue;
      const id = (m as ChatMessage & { tool_call_id?: string }).tool_call_id ?? '';
      if (!PRUNABLE_TOOLS.has(callIdToName.get(id) ?? '')) continue;
      seen++;
      graceFrom = i;
    }
  }

  let pruned = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    if (i >= protectedFrom) continue; // in protected zone — never touch
    if (i >= graceFrom) continue; // recently read — grace window, never touch yet

    const toolCallId = (m as ChatMessage & { tool_call_id?: string }).tool_call_id ?? '';
    const toolName = callIdToName.get(toolCallId) ?? '';
    if (!PRUNABLE_TOOLS.has(toolName)) continue;

    const content = stringifyContent(m.content);
    if (content.length <= MIN_PRUNE_CHARS) continue;
    // Already pruned in a previous pass.
    if (content.startsWith('[pruned:')) continue;

    // Extract file paths referenced by this result.
    const paths = extractPathsFromToolResult(toolName, content);

    // If we can't extract any paths, be conservative: don't prune.
    // (Unknown content shape → might be something we'd regret deleting.)
    if (paths.size === 0) continue;

    // Build downstream text ONCE per candidate (lazily, covers i+1…end).
    const downstream = buildDownstreamText(messages, i + 1);

    // If ANY of the paths still appear downstream, keep the result intact.
    // Normalize each path's separators to forward slashes to match
    // buildDownstreamText (which collapses all backslashes to `/`), otherwise
    // Windows backslash paths extracted here would never match downstream text.
    let stillReferenced = false;
    for (const p of paths) {
      const norm = p.replace(/\\/g, '/');
      if (downstream.includes(norm)) {
        stillReferenced = true;
        break;
      }
    }
    if (stillReferenced) continue;

    // Safe to prune. Build a one-line sentinel so the model knows it once
    // had this context (useful for self-awareness) without storing the bulk.
    const primary = [...paths][0];
    const sentinel = `[pruned: ${toolName} ${primary}${paths.size > 1 ? ` (+${paths.size - 1} more)` : ''} — content removed, no longer needed]`;
    messages[i] = { ...m, content: sentinel } as ChatMessage;
    pruned++;
  }

  return pruned;
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
