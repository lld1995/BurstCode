import OpenAI from 'openai';
import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from '../util/Logger';

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  contextWindow: number;
  /** Skip TLS cert verification for the configured baseURL (self-signed corporate endpoints). */
  allowSelfSignedCerts?: boolean;
}

/**
 * A profile = a complete, self-contained LLM configuration. Two profiles are
 * tracked as separate top-level settings so the VS Code Settings UI can
 * render an inline form for each (instead of falling back to "Edit in
 * settings.json" the way an array-of-objects schema does):
 *
 *   - `burstcode.llm.chat`        — foreground (chat panel)
 *   - `burstcode.llm.background`  — idle-time explorer (with `inherit`)
 *
 * Empty string fields on the background profile fall back to the chat
 * profile so the user can override only the parts they care about.
 */
export interface LLMProfile {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  contextWindow: number;
  allowSelfSignedCerts: boolean;
  /** User-curated model list shown in the picker alongside fetched ones. */
  models: string[];
}

export interface BackgroundProfile extends LLMProfile {
  /** When true, the explorer ignores its own fields and uses the chat profile. */
  inherit: boolean;
}

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_API_KEY = '';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_CONTEXT_WINDOW = 131072;

/**
 * Read every field of a profile via individual flat-key lookups
 * (`burstcode.llm.<scope>.baseURL`, …). Each field is declared as its own
 * top-level configuration property in package.json so the VS Code Settings
 * UI can render an inline editor for it; storing the whole profile as a
 * single object would force users to fall back to "Edit in settings.json".
 *
 * `cfg.get('chat.baseURL')` also descends into a legacy object form (where
 * `burstcode.llm.chat` is set as `{ baseURL: ... }` in settings.json), so
 * users coming from an earlier preview keep working until the activation-
 * time migration cleans things up.
 */
function readProfile(scope: 'chat' | 'background', defaults: Partial<LLMProfile> = {}): LLMProfile {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const baseURL = cfg.get<string>(`${scope}.baseURL`);
  const apiKey = cfg.get<string>(`${scope}.apiKey`);
  const model = cfg.get<string>(`${scope}.model`);
  const temperature = cfg.get<number>(`${scope}.temperature`);
  const contextWindow = cfg.get<number>(`${scope}.contextWindow`);
  const allowSelfSignedCerts = cfg.get<boolean>(`${scope}.allowSelfSignedCerts`);
  const models = cfg.get<string[]>(`${scope}.models`);

  return {
    baseURL: typeof baseURL === 'string' ? baseURL.trim() : (defaults.baseURL ?? ''),
    apiKey: typeof apiKey === 'string' ? apiKey : (defaults.apiKey ?? ''),
    model: typeof model === 'string' ? model.trim() : (defaults.model ?? ''),
    temperature:
      typeof temperature === 'number' ? temperature : (defaults.temperature ?? DEFAULT_TEMPERATURE),
    contextWindow:
      typeof contextWindow === 'number' && contextWindow > 0
        ? contextWindow
        : (defaults.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    allowSelfSignedCerts:
      typeof allowSelfSignedCerts === 'boolean'
        ? allowSelfSignedCerts
        : (defaults.allowSelfSignedCerts === true),
    models: Array.isArray(models)
      ? models
          .filter((m): m is string => typeof m === 'string' && !!m.trim())
          .map((m) => m.trim())
      : (defaults.models ?? [])
  };
}

/** Read the chat profile, applying sensible defaults so a fresh install works. */
export function readChatProfile(): LLMProfile {
  return readProfile('chat', {
    baseURL: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_KEY,
    model: DEFAULT_MODEL
  });
}

/** Read the background profile (raw — does NOT apply `inherit` fallback). */
export function readBackgroundProfile(): BackgroundProfile {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const inheritRaw = cfg.get<boolean>('background.inherit');
  // Only inherit when the user has explicitly opted in.  An unset value is
  // treated as false so that a fresh install without a baseURL does not
  // silently fall back to the chat endpoint.
  const inherit = inheritRaw === true;
  return { ...readProfile('background'), inherit };
}

export function readLLMConfig(): LLMConfig {
  const p = readChatProfile();
  return {
    baseURL: p.baseURL || DEFAULT_BASE_URL,
    apiKey: p.apiKey,
    model: p.model || p.models[0] || DEFAULT_MODEL,
    temperature: p.temperature,
    contextWindow: p.contextWindow,
    allowSelfSignedCerts: p.allowSelfSignedCerts
  };
}

/**
 * Resolve the background profile to a fully-specified LLMConfig.
 *
 * Returns `null` when `inherit` is not explicitly `true` and no `baseURL`
 * has been set — in that case the caller must NOT fall back to the chat
 * endpoint and should skip the background cycle entirely.
 *
 * When the user explicitly sets `inherit: true` the chat profile is used
 * as-is.  When `inherit: false` (or unset) and a `baseURL` is present,
 * empty secondary fields
 * (apiKey, model, …) still fall back to the chat profile so the user only
 * has to fill in the parts that differ.
 */
export function resolveBackgroundLLMConfig(): LLMConfig | null {
  const bg = readBackgroundProfile();
  if (bg.inherit) return readLLMConfig();
  // Explicit non-inherit mode: refuse to run if no endpoint has been configured.
  if (!bg.baseURL) return null;
  const chat = readLLMConfig();
  return {
    baseURL: bg.baseURL,
    apiKey: bg.apiKey || chat.apiKey,
    model: bg.model || bg.models[0] || chat.model,
    temperature: typeof bg.temperature === 'number' ? bg.temperature : chat.temperature,
    contextWindow: bg.contextWindow > 0 ? bg.contextWindow : chat.contextWindow,
    allowSelfSignedCerts: bg.allowSelfSignedCerts
  };
}

/* ------------------------------------------------------------------ */
/* Mutation helpers — every write goes through `cfg.update(..., Global)` */
/* ------------------------------------------------------------------ */

/**
 * Write a partial profile patch one key at a time so each lands in
 * settings.json under its own dotted path
 * (e.g. `"burstcode.llm.chat.model": "..."`). Writing the whole profile as
 * a single object would re-introduce the very shape the Settings UI can't
 * edit inline.
 */
async function writeProfilePatch(
  scope: 'chat' | 'background',
  patch: Partial<BackgroundProfile>
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.slice() : v;
    // Write to whichever scope is currently winning so that a workspace-level
    // override isn't silently shadowed by a Global write that never takes effect.
    const inspected = cfg.inspect(`${scope}.${k}`);
    const target =
      inspected?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await cfg.update(`${scope}.${k}`, value, target);
  }
}

export async function updateChatProfile(patch: Partial<LLMProfile>): Promise<void> {
  await writeProfilePatch('chat', patch);
}

export async function updateBackgroundProfile(
  patch: Partial<BackgroundProfile>
): Promise<void> {
  await writeProfilePatch('background', patch);
}

export async function setChatModel(model: string): Promise<void> {
  await updateChatProfile({ model: model.trim() });
}

export async function addChatModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const cur = readChatProfile();
  if (cur.models.includes(trimmed)) return;
  await updateChatProfile({ models: [...cur.models, trimmed] });
}

export async function removeChatModel(model: string): Promise<void> {
  const cur = readChatProfile();
  await updateChatProfile({ models: cur.models.filter((m) => m !== model) });
}

export async function addBackgroundModel(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const cur = readBackgroundProfile();
  if (cur.models.includes(trimmed)) return;
  await updateBackgroundProfile({ models: [...cur.models, trimmed] });
}

export async function removeBackgroundModel(model: string): Promise<void> {
  const cur = readBackgroundProfile();
  await updateBackgroundProfile({ models: cur.models.filter((m) => m !== model) });
}

/**
 * Probe the profile's `/models` endpoint (OpenAI-compatible). Returns model
 * IDs sorted alphabetically. Throws on transport/auth errors so callers can
 * show a meaningful message in the UI.
 */
export async function fetchProfileModels(profile: {
  baseURL: string;
  apiKey?: string;
  allowSelfSignedCerts?: boolean;
}): Promise<string[]> {
  const opts: ConstructorParameters<typeof OpenAI>[0] = {
    baseURL: profile.baseURL,
    apiKey: profile.apiKey || 'no-key',
    // Fail fast on broken endpoints — the UI shows a clear error to the
    // user instead of stalling through three silent SDK retries.
    maxRetries: 0
  };
  if (profile.allowSelfSignedCerts) {
    opts.httpAgent = new https.Agent({ rejectUnauthorized: false });
  }
  const client = new OpenAI(opts);
  const res = await client.models.list();
  const ids = res.data
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((id) => !!id);
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

/**
 * Persistent cache of `/v1/models` responses keyed by baseURL. Lives in the
 * extension's globalState so a fetched list survives webview reloads and
 * IDE restarts; the model picker can show the previously-fetched ids
 * immediately and only re-hit the network when the user clicks Refresh.
 */
const FETCHED_MODELS_CACHE_KEY = 'burstcode.llm.fetchedModelsCache.v1';

export interface FetchedModelsCacheEntry {
  models: string[];
  fetchedAt: number;
}

type FetchedModelsCache = Record<string, FetchedModelsCacheEntry>;

function readFetchedModelsCache(memento: vscode.Memento): FetchedModelsCache {
  const raw = memento.get<FetchedModelsCache>(FETCHED_MODELS_CACHE_KEY);
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

/** Look up the cached `/v1/models` response for the given baseURL, if any. */
export function getCachedFetchedModels(
  memento: vscode.Memento,
  baseURL: string
): FetchedModelsCacheEntry | null {
  const url = (baseURL || '').trim();
  if (!url) return null;
  const cache = readFetchedModelsCache(memento);
  const entry = cache[url];
  if (!entry || !Array.isArray(entry.models)) return null;
  const models = entry.models.filter(
    (m): m is string => typeof m === 'string' && !!m
  );
  const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0;
  return { models, fetchedAt };
}

/** Persist a successful `/v1/models` response under the given baseURL. */
export async function writeCachedFetchedModels(
  memento: vscode.Memento,
  baseURL: string,
  models: string[]
): Promise<void> {
  const url = (baseURL || '').trim();
  if (!url) return;
  const cache = readFetchedModelsCache(memento);
  cache[url] = { models: models.slice(), fetchedAt: Date.now() };
  await memento.update(FETCHED_MODELS_CACHE_KEY, cache);
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  finishReason?: string;
}

/**
 * Some "thinking" models (Qwen3, GLM-thinking, Kimi, etc.) emit their chain of
 * thought inline inside `delta.content` wrapped in `<think>...</think>` tags
 * instead of using the dedicated `reasoning_content` field. This splitter
 * walks the streamed content character-by-character and re-routes anything
 * inside the tags to `reasoningDelta`, leaving the user-visible answer in
 * `contentDelta`. It buffers up to a few bytes across chunks so a tag split
 * across stream boundaries (e.g. "<thi" + "nk>") is still detected.
 *
 * Models that already separate reasoning into `delta.reasoning_content`
 * (DeepSeek V4, OpenRouter reasoning-capable models, ...) emit no `<think>`
 * tags in `delta.content`, so the splitter is a transparent pass-through for
 * them.
 */
class ThinkSplitter {
  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';
  private mode: 'outside' | 'inside' = 'outside';
  private buf = '';

  feed(text: string, isFinal = false): StreamChunk[] {
    if (text) this.buf += text;
    const out: StreamChunk[] = [];
    while (true) {
      if (this.mode === 'outside') {
        const idx = this.buf.indexOf(ThinkSplitter.OPEN);
        if (idx >= 0) {
          const before = this.buf.slice(0, idx);
          if (before) out.push({ contentDelta: before });
          this.buf = this.buf.slice(idx + ThinkSplitter.OPEN.length);
          this.mode = 'inside';
          continue;
        }
        // Hold back enough bytes to detect a tag straddling the next chunk.
        const safe = isFinal
          ? this.buf.length
          : Math.max(0, this.buf.length - (ThinkSplitter.OPEN.length - 1));
        if (safe > 0) {
          out.push({ contentDelta: this.buf.slice(0, safe) });
          this.buf = this.buf.slice(safe);
        }
        break;
      } else {
        const idx = this.buf.indexOf(ThinkSplitter.CLOSE);
        if (idx >= 0) {
          const before = this.buf.slice(0, idx);
          if (before) out.push({ reasoningDelta: before });
          this.buf = this.buf.slice(idx + ThinkSplitter.CLOSE.length);
          this.mode = 'outside';
          continue;
        }
        const safe = isFinal
          ? this.buf.length
          : Math.max(0, this.buf.length - (ThinkSplitter.CLOSE.length - 1));
        if (safe > 0) {
          out.push({ reasoningDelta: this.buf.slice(0, safe) });
          this.buf = this.buf.slice(safe);
        }
        break;
      }
    }
    return out;
  }
}

/**
 * DashScope's Qwen-thinking endpoint validates the request body by walking
 * every assistant message and demanding that `reasoning_content` be present
 * (even as an empty string) once thinking mode has been engaged anywhere in
 * the session. Any missing field — whether on a turn that didn't think, on a
 * pre-thinking-era message restored from disk, or on a partial turn left
 * behind by a cancelled stream — trips the
 *   400 The `reasoning_content` in the thinking mode must be passed back
 *       to the API.
 * response. We backfill an empty string when the field is missing so the
 * request always validates while preserving any captured chain-of-thought.
 */
function normalizeReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  // Only backfill reasoning_content when the session has actually engaged
  // thinking mode at least once. Unconditionally adding the field to every
  // assistant message can trigger "failed to marshal request body to JSON"
  // errors in Go-based API proxies that don't expect the extra field.
  const hasThinking = messages.some((m) => {
    if (m.role !== 'assistant') return false;
    const rc = (m as unknown as Record<string, unknown>).reasoning_content;
    return typeof rc === 'string' && rc.length > 0;
  });
  if (!hasThinking) return messages;
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const am = m as ChatMessage & { reasoning_content?: unknown };
    if (typeof am.reasoning_content === 'string') return m;
    return { ...m, reasoning_content: '' } as ChatMessage;
  });
}

/**
 * Prepare messages for the target model, applying model-specific normalisation:
 *
 * Claude (native Anthropic API or OpenAI-compatible proxies that translate to it):
 *   1. Strip `reasoning_content` entirely — proxies convert this field into an
 *      Anthropic `thinking` content block and then reject the request because they
 *      cannot synthesise a valid `signature`, producing:
 *        400 messages.1.content.0.thinking.signature: Field required
 *   2. Strip `thinking`-type content blocks that lack a valid `signature` — such
 *      blocks arise when a session was saved without the original signature (e.g.
 *      after a cancelled stream or a schema migration) and trigger the same error
 *      on round-trip.
 *
 * All other models (Qwen/DashScope, DeepSeek, …):
 *   Backfill `reasoning_content: ''` when the field is absent so Qwen-thinking
 *   endpoints always receive a shape-correct request body.
 */
function prepareMessagesForModel(messages: ChatMessage[], model: string): ChatMessage[] {
  if (model.toLowerCase().includes('claude')) {
    return messages.map((m) => {
      if (m.role !== 'assistant') return m;
      // 1. Drop reasoning_content so no proxy can synthesise a thinking block.
      const { reasoning_content: _rc, ...rest } =
        m as ChatMessage & { reasoning_content?: unknown };
      let msg = rest as ChatMessage;
      // 2. Strip thinking blocks that are missing a valid signature.
      if (Array.isArray(msg.content)) {
        const filtered = (msg.content as Array<unknown>).filter((block) => {
          if (!block || typeof block !== 'object') return true;
          const b = block as Record<string, unknown>;
          if (b.type !== 'thinking') return true;
          return typeof b.signature === 'string' && b.signature.length > 0;
        });
        if (filtered.length !== (msg.content as Array<unknown>).length) {
          msg = { ...msg, content: filtered.length > 0 ? (filtered as typeof msg.content) : null } as ChatMessage;
        }
      }
      return msg;
    });
  }
  return normalizeReasoningContent(messages);
}

export class OpenAIClient {
  private client: OpenAI;

  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      baseURL: config.baseURL,
      apiKey: config.apiKey || 'no-key',
      // Disable the SDK's built-in retry loop (default 2). All retry logic
      // lives in AgentLoop where each attempt emits an `auto-resume` event
      // so the user can see what's happening. Without this, a flaky endpoint
      // can produce up to (1 + sdkRetries) × (1 + maxAutoResumes) = 12 silent
      // HTTP requests per turn with only 3 visible auto-resume pills.
      maxRetries: 0
    };
    if (config.allowSelfSignedCerts) {
      // Per-client agent so we don't relax TLS globally for the host process.
      opts.httpAgent = new https.Agent({ rejectUnauthorized: false });
      logger.warn(
        `TLS verification disabled for ${config.baseURL} (allowSelfSignedCerts=true). Only use with trusted endpoints.`
      );
    }
    this.client = new OpenAI(opts);
  }

  async *streamChat(
    messages: ChatMessage[],
    tools: ToolDef[],
    cancellation: vscode.CancellationToken
  ): AsyncGenerator<StreamChunk, void, void> {
    // Wire an AbortController to the cancellation token BEFORE any await so
    // that clicking Stop cancels the initial HTTP request too — not only the
    // streaming body. Without this, a hung/slow endpoint blocks `create()`
    // forever and the cancellation listener never gets registered, leaving
    // the user with a frozen run that can't be stopped.
    const ac = new AbortController();
    if (cancellation.isCancellationRequested) ac.abort();
    const sub = cancellation.onCancellationRequested(() => {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    });

    // Normalise the message history for the target model before sending.
    // See prepareMessagesForModel for the per-model rules.
    const safeMessages = prepareMessagesForModel(messages, this.config.model);

    // Some models (e.g. claude-* via OpenAI-compatible endpoints, or the same
    // models accessed via OpenRouter as "anthropic/claude-*") reject the
    // temperature field entirely. Match on any model name that contains "claude"
    // regardless of prefix so both direct and proxied names are covered.
    const supportsTemperature = !this.config.model.toLowerCase().includes('claude');

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: safeMessages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          // Encourage the model to batch independent tool calls into a single
          // assistant message. OpenAI GPT-4o / o-series default to true but
          // some OpenAI-compatible backends (DashScope, certain vLLM builds,
          // OpenRouter proxies) need this set explicitly to actually emit
          // multiple tool_calls per turn. Unknown servers ignore the field.
          parallel_tool_calls: tools.length ? true : undefined,
          ...(supportsTemperature ? { temperature: this.config.temperature } : {}),
          stream: true
        },
        { signal: ac.signal }
      );

      const splitter = new ThinkSplitter();

      for await (const part of stream) {
        const choice = part.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          for (const c of splitter.feed(delta.content)) yield c;
        }
        // @ts-expect-error - reasoning_content may be present for thinking models (DeepSeek V4, OpenRouter, etc.)
        if (delta?.reasoning_content) {
          // @ts-expect-error
          yield { reasoningDelta: delta.reasoning_content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              toolCallDelta: {
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments
              }
            };
          }
        }
        if (choice.finish_reason) {
          // Flush any bytes the splitter held back waiting for a tag boundary
          // before forwarding the finish event.
          for (const c of splitter.feed('', true)) yield c;
          yield { finishReason: choice.finish_reason };
        }
      }
      // Defensive flush in case the upstream stream ends without ever sending
      // a finish_reason (some self-hosted vLLM/sglang frontends do this).
      for (const c of splitter.feed('', true)) yield c;
    } finally {
      sub.dispose();
    }
  }
}
