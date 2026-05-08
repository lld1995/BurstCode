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
 * An endpoint = a remote server (baseURL + apiKey + connection options).
 * Models are tracked separately so the user can pick any model the endpoint
 * exposes (via /v1/models) or supplement the list manually.
 */
export interface LLMEndpoint {
  name: string;
  baseURL: string;
  apiKey: string;
  temperature: number;
  contextWindow: number;
  allowSelfSignedCerts: boolean;
  /** User-curated model list for this endpoint (manual additions). */
  models: string[];
}

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_API_KEY = 'none';
const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_CONTEXT_WINDOW = 32768;
// Use the URL itself as the default endpoint name so the picker is
// self-describing on a fresh install (e.g. "http://localhost:11434/v1").
const DEFAULT_ENDPOINT_NAME = DEFAULT_BASE_URL;

/**
 * Read every configured endpoint from `burstcode.llm.endpoints`. If the user
 * has not added any yet, return a single sensible local default so the
 * extension is usable on a fresh install.
 */
export function readEndpoints(): LLMEndpoint[] {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const out: LLMEndpoint[] = [];
  const seen = new Set<string>();

  const rawEndpoints = cfg.get<Array<Partial<LLMEndpoint>>>('endpoints') ?? [];
  for (const r of rawEndpoints) {
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      baseURL: typeof r.baseURL === 'string' && r.baseURL ? r.baseURL : DEFAULT_BASE_URL,
      apiKey: typeof r.apiKey === 'string' && r.apiKey ? r.apiKey : DEFAULT_API_KEY,
      contextWindow:
        typeof r.contextWindow === 'number' && r.contextWindow > 0
          ? r.contextWindow
          : DEFAULT_CONTEXT_WINDOW,
      temperature: typeof r.temperature === 'number' ? r.temperature : DEFAULT_TEMPERATURE,
      allowSelfSignedCerts: r.allowSelfSignedCerts === true,
      models: Array.isArray(r.models)
        ? r.models
            .filter((m): m is string => typeof m === 'string' && !!m.trim())
            .map((m) => m.trim())
        : []
    });
  }

  if (out.length === 0) {
    out.push({
      name: DEFAULT_ENDPOINT_NAME,
      baseURL: DEFAULT_BASE_URL,
      apiKey: DEFAULT_API_KEY,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      temperature: DEFAULT_TEMPERATURE,
      allowSelfSignedCerts: false,
      models: [DEFAULT_MODEL]
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Active profile (chat) and background profile                       */
/* ------------------------------------------------------------------ */

/**
 * Profile = which (endpoint, model) the runtime should use right now. Two
 * profiles are tracked: `chat` (foreground panel) and `background`
 * (idle-time explorer). Each profile is just a pair of strings; everything
 * else — baseURL, apiKey, contextWindow, temperature, TLS — lives on the
 * referenced endpoint inside `burstcode.llm.endpoints`. The background
 * profile additionally has an `inherit` flag that pins it to whatever
 * `chat` is currently using.
 */
export interface BackgroundProfile {
  inherit: boolean;
  endpoint: string;
  model: string;
}

function readChatProfile(): { endpoint: string; model: string } {
  const p = vscode.workspace.getConfiguration('burstcode.profiles');
  return {
    endpoint: (p.get<string>('chat.endpoint') ?? '').trim(),
    model: (p.get<string>('chat.model') ?? '').trim()
  };
}

export function getActiveEndpointName(): string | undefined {
  const v = readChatProfile().endpoint;
  return v || undefined;
}

export function getActiveModelName(): string | undefined {
  const v = readChatProfile().model;
  return v || undefined;
}

export function getActiveEndpoint(): LLMEndpoint {
  const endpoints = readEndpoints();
  const name = getActiveEndpointName();
  return endpoints.find((e) => e.name === name) ?? endpoints[0];
}

/** Persist the user's active chat endpoint+model selection. */
export async function setActiveSelection(endpointName: string, modelName: string): Promise<void> {
  const profiles = vscode.workspace.getConfiguration('burstcode.profiles');
  await profiles.update('chat.endpoint', endpointName, vscode.ConfigurationTarget.Global);
  await profiles.update('chat.model', modelName, vscode.ConfigurationTarget.Global);
}

export function getBackgroundProfile(): BackgroundProfile {
  const p = vscode.workspace.getConfiguration('burstcode.profiles');
  return {
    inherit: p.get<boolean>('background.inherit') ?? true,
    endpoint: (p.get<string>('background.endpoint') ?? '').trim(),
    model: (p.get<string>('background.model') ?? '').trim()
  };
}

export async function setBackgroundProfile(
  next: { inherit?: boolean; endpoint?: string; model?: string }
): Promise<void> {
  const p = vscode.workspace.getConfiguration('burstcode.profiles');
  if (typeof next.inherit === 'boolean') {
    await p.update('background.inherit', next.inherit, vscode.ConfigurationTarget.Global);
  }
  if (typeof next.endpoint === 'string') {
    await p.update('background.endpoint', next.endpoint, vscode.ConfigurationTarget.Global);
  }
  if (typeof next.model === 'string') {
    await p.update('background.model', next.model, vscode.ConfigurationTarget.Global);
  }
}

/** Resolve the background profile to a fully-specified LLMConfig. */
export function resolveBackgroundLLMConfig(): LLMConfig {
  const profile = getBackgroundProfile();
  if (profile.inherit) return readLLMConfig();
  const endpoints = readEndpoints();
  const ep = endpoints.find((e) => e.name === profile.endpoint) ?? getActiveEndpoint();
  const fallback = readLLMConfig();
  const model = profile.model || ep.models[0] || fallback.model;
  return {
    baseURL: ep.baseURL,
    apiKey: ep.apiKey,
    model,
    temperature: ep.temperature,
    contextWindow: ep.contextWindow,
    allowSelfSignedCerts: ep.allowSelfSignedCerts
  };
}

/** Persist a manually-added model under the given endpoint (no-op if dup). */
export async function addModelToEndpoint(endpointName: string, model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const endpoints = readEndpoints();
  // Materialise the endpoints array so legacy profile-only setups still get
  // a writable endpoints[] entry to attach the new model to.
  const next = endpoints.map((e) => ({
    name: e.name,
    baseURL: e.baseURL,
    apiKey: e.apiKey,
    contextWindow: e.contextWindow,
    temperature: e.temperature,
    allowSelfSignedCerts: e.allowSelfSignedCerts,
    models: e.models.slice()
  }));
  const target = next.find((e) => e.name === endpointName);
  if (!target) return;
  if (!target.models.includes(trimmed)) target.models.push(trimmed);
  await cfg.update('endpoints', next, vscode.ConfigurationTarget.Global);
}

export async function removeModelFromEndpoint(endpointName: string, model: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const endpoints = readEndpoints();
  const next = endpoints.map((e) => ({
    name: e.name,
    baseURL: e.baseURL,
    apiKey: e.apiKey,
    contextWindow: e.contextWindow,
    temperature: e.temperature,
    allowSelfSignedCerts: e.allowSelfSignedCerts,
    models: e.models.filter((m) => m !== model)
  }));
  await cfg.update('endpoints', next, vscode.ConfigurationTarget.Global);
}

/**
 * Probe the endpoint's `/models` listing (OpenAI-compatible). Returns model IDs
 * sorted alphabetically. Throws on transport / auth errors so callers can show
 * a meaningful message in the UI.
 */
export async function fetchEndpointModels(endpoint: LLMEndpoint): Promise<string[]> {
  const opts: ConstructorParameters<typeof OpenAI>[0] = {
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey || 'no-key'
  };
  if (endpoint.allowSelfSignedCerts) {
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

export function readLLMConfig(): LLMConfig {
  const ep = getActiveEndpoint();
  const model = getActiveModelName() || ep.models[0] || DEFAULT_MODEL;
  return {
    baseURL: ep.baseURL,
    apiKey: ep.apiKey,
    model,
    temperature: ep.temperature,
    contextWindow: ep.contextWindow,
    allowSelfSignedCerts: ep.allowSelfSignedCerts
  };
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
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const am = m as ChatMessage & { reasoning_content?: unknown };
    if (typeof am.reasoning_content === 'string') return m;
    return { ...m, reasoning_content: '' } as ChatMessage;
  });
}

export class OpenAIClient {
  private client: OpenAI;

  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = {
      baseURL: config.baseURL,
      apiKey: config.apiKey || 'no-key'
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

    // DashScope / Qwen-thinking strictly enforces that any assistant message
    // returned by a thinking model must round-trip the `reasoning_content`
    // field on subsequent requests — the server replies with
    //   400 The `reasoning_content` in the thinking mode must be passed back
    //       to the API.
    // when the field is missing on ANY assistant message in the history. We
    // already attach it on freshly-streamed turns (see AgentLoop), but stale
    // sessions, mid-stream cancellations, and turns where the model chose not
    // to think can all leave the field absent. Backfill an empty string here
    // so the request body is always shape-correct without losing the original
    // chain-of-thought when one was captured. Other OpenAI-compatible servers
    // simply ignore unknown fields, so this is safe to send unconditionally.
    const safeMessages = normalizeReasoningContent(messages);

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: safeMessages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          temperature: this.config.temperature,
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
