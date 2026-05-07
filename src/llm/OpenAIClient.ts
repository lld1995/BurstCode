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
const DEFAULT_ENDPOINT_NAME = 'Local';

/**
 * Read all configured endpoints. Always returns at least one entry, derived in
 * order from:
 *   1. `burstcode.llm.endpoints` (the new structure)
 *   2. `burstcode.llm.profiles`  (legacy: each profile becomes an endpoint and
 *      contributes its model to the endpoint's model list)
 *   3. The legacy single-model settings (baseURL/apiKey/model)
 */
export function readEndpoints(): LLMEndpoint[] {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const out: LLMEndpoint[] = [];
  const byName = new Map<string, LLMEndpoint>();

  const upsert = (ep: LLMEndpoint): void => {
    const existing = byName.get(ep.name);
    if (existing) {
      // Merge model lists, preserving order.
      for (const m of ep.models) {
        if (!existing.models.includes(m)) existing.models.push(m);
      }
      return;
    }
    byName.set(ep.name, ep);
    out.push(ep);
  };

  const rawEndpoints = cfg.get<Array<Partial<LLMEndpoint>>>('endpoints') ?? [];
  for (const r of rawEndpoints) {
    if (!r || typeof r !== 'object') continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    upsert({
      name,
      baseURL: typeof r.baseURL === 'string' && r.baseURL ? r.baseURL : (cfg.get<string>('baseURL') ?? DEFAULT_BASE_URL),
      apiKey: typeof r.apiKey === 'string' && r.apiKey ? r.apiKey : (cfg.get<string>('apiKey') ?? DEFAULT_API_KEY),
      contextWindow: typeof r.contextWindow === 'number' && r.contextWindow > 0
        ? r.contextWindow
        : (cfg.get<number>('contextWindow') ?? DEFAULT_CONTEXT_WINDOW),
      temperature: typeof r.temperature === 'number'
        ? r.temperature
        : (cfg.get<number>('temperature') ?? DEFAULT_TEMPERATURE),
      allowSelfSignedCerts: typeof r.allowSelfSignedCerts === 'boolean'
        ? r.allowSelfSignedCerts
        : (cfg.get<boolean>('allowSelfSignedCerts') ?? false),
      models: Array.isArray(r.models)
        ? r.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
        : []
    });
  }

  // Legacy: each profile becomes (or extends) an endpoint, contributing its
  // model to the endpoint's manual list.
  const rawProfiles = cfg.get<Array<{ name?: string; baseURL?: string; apiKey?: string; model?: string; contextWindow?: number; temperature?: number; allowSelfSignedCerts?: boolean }>>('profiles') ?? [];
  for (const p of rawProfiles) {
    if (!p || typeof p !== 'object') continue;
    const model = typeof p.model === 'string' ? p.model.trim() : '';
    if (!model) continue;
    const name = (typeof p.name === 'string' && p.name.trim()) || model;
    upsert({
      name,
      baseURL: typeof p.baseURL === 'string' && p.baseURL ? p.baseURL : (cfg.get<string>('baseURL') ?? DEFAULT_BASE_URL),
      apiKey: typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : (cfg.get<string>('apiKey') ?? DEFAULT_API_KEY),
      contextWindow: typeof p.contextWindow === 'number' && p.contextWindow > 0
        ? p.contextWindow
        : (cfg.get<number>('contextWindow') ?? DEFAULT_CONTEXT_WINDOW),
      temperature: typeof p.temperature === 'number'
        ? p.temperature
        : (cfg.get<number>('temperature') ?? DEFAULT_TEMPERATURE),
      allowSelfSignedCerts: typeof p.allowSelfSignedCerts === 'boolean'
        ? p.allowSelfSignedCerts
        : (cfg.get<boolean>('allowSelfSignedCerts') ?? false),
      models: [model]
    });
  }

  if (out.length === 0) {
    // Final fallback: synthesize a single endpoint from the legacy single-model
    // settings so the extension is usable on a fresh install.
    const legacyModel = cfg.get<string>('model') ?? DEFAULT_MODEL;
    out.push({
      name: DEFAULT_ENDPOINT_NAME,
      baseURL: cfg.get<string>('baseURL') ?? DEFAULT_BASE_URL,
      apiKey: cfg.get<string>('apiKey') ?? DEFAULT_API_KEY,
      contextWindow: cfg.get<number>('contextWindow') ?? DEFAULT_CONTEXT_WINDOW,
      temperature: cfg.get<number>('temperature') ?? DEFAULT_TEMPERATURE,
      allowSelfSignedCerts: cfg.get<boolean>('allowSelfSignedCerts') ?? false,
      models: legacyModel ? [legacyModel] : []
    });
  }

  return out;
}

export function getActiveEndpointName(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const v = cfg.get<string>('activeEndpoint');
  if (v && v.trim()) return v.trim();
  // Fallback to the legacy `activeProfile` so existing users keep their pick.
  const legacy = cfg.get<string>('activeProfile');
  return legacy && legacy.trim() ? legacy.trim() : undefined;
}

export function getActiveModelName(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const v = cfg.get<string>('activeModel');
  return v && v.trim() ? v.trim() : undefined;
}

export function getActiveEndpoint(): LLMEndpoint {
  const endpoints = readEndpoints();
  const name = getActiveEndpointName();
  return endpoints.find((e) => e.name === name) ?? endpoints[0];
}

/** Persist the user's active endpoint+model selection. */
export async function setActiveSelection(endpointName: string, modelName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  await cfg.update('activeEndpoint', endpointName, vscode.ConfigurationTarget.Global);
  await cfg.update('activeModel', modelName, vscode.ConfigurationTarget.Global);
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
  const activeModel = getActiveModelName();
  // Resolve the model: explicit selection > endpoint's first known model >
  // legacy `burstcode.llm.model` fallback.
  const fallback = vscode.workspace.getConfiguration('burstcode.llm').get<string>('model') ?? DEFAULT_MODEL;
  const model = activeModel || ep.models[0] || fallback;
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
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: this.config.temperature,
      stream: true
    });

    cancellation.onCancellationRequested(() => {
      try {
        stream.controller.abort();
      } catch {
        /* ignore */
      }
    });

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
    // Defensive flush in case the upstream stream ends without ever sending a
    // finish_reason (some self-hosted vLLM/sglang frontends do this).
    for (const c of splitter.feed('', true)) yield c;
  }
}
