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

/* ------------------------------------------------------------------ */
/* Image generation profile (/v1/images/generations)                    */
/* ------------------------------------------------------------------ */

export interface ImageConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  size: string;
  allowSelfSignedCerts: boolean;
}

const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_IMAGE_SIZE = '1024x1024';

/**
 * Resolve the image-generation profile. Each field falls back to the chat
 * profile when left empty so the user only has to set the parts that differ
 * (typically just the model id, e.g. `gpt-image-2`). Image models speak the
 * `/v1/images/generations` endpoint, NOT `/v1/chat/completions`, so they can
 * never be used as the chat model directly.
 */
export function readImageConfig(): ImageConfig {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const chat = readLLMConfig();
  const baseURL = (cfg.get<string>('image.baseURL') ?? '').trim();
  const apiKey = cfg.get<string>('image.apiKey');
  const model = (cfg.get<string>('image.model') ?? '').trim();
  const size = (cfg.get<string>('image.size') ?? '').trim();
  const allow = cfg.get<boolean>('image.allowSelfSignedCerts');
  return {
    baseURL: baseURL || chat.baseURL,
    apiKey: typeof apiKey === 'string' && apiKey ? apiKey : chat.apiKey,
    model: model || DEFAULT_IMAGE_MODEL,
    size: size || DEFAULT_IMAGE_SIZE,
    allowSelfSignedCerts:
      typeof allow === 'boolean' ? allow : chat.allowSelfSignedCerts === true
  };
}

export interface GeneratedImage {
  /** Raw image bytes (decoded from b64_json or downloaded from the URL). */
  data: Buffer;
  /** Reported MIME type, defaults to image/png. */
  mimeType: string;
  /** The revised prompt the model actually used, when provided. */
  revisedPrompt?: string;
}

/**
 * Generate one image via the OpenAI-compatible `/v1/images/generations`
 * endpoint. Prefers `response_format: b64_json` so the bytes come back inline
 * (no second download round-trip); falls back to fetching the returned URL
 * when an endpoint only supports URL responses.
 */
export async function generateImage(
  cfg: ImageConfig,
  prompt: string,
  opts: { size?: string; signal?: AbortSignal } = {}
): Promise<GeneratedImage> {
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey || 'no-key',
    maxRetries: 0
  };
  if (cfg.allowSelfSignedCerts) {
    clientOpts.httpAgent = new https.Agent({ rejectUnauthorized: false });
  }
  const client = new OpenAI(clientOpts);

  const size = (opts.size || cfg.size || DEFAULT_IMAGE_SIZE).trim();
  const res = await client.images.generate(
    {
      model: cfg.model,
      prompt,
      n: 1,
      size: size as never
    } as never,
    opts.signal ? { signal: opts.signal } : undefined
  );

  const first = res.data?.[0] as
    | { b64_json?: string; url?: string; revised_prompt?: string }
    | undefined;
  if (!first) throw new Error('Image endpoint returned no image data.');

  let data: Buffer;
  let mimeType = 'image/png';
  if (first.b64_json) {
    data = Buffer.from(first.b64_json, 'base64');
  } else if (first.url) {
    const fetched = await downloadBytes(first.url, cfg.allowSelfSignedCerts, opts.signal);
    data = fetched.body;
    if (fetched.mimeType) mimeType = fetched.mimeType;
  } else {
    throw new Error('Image endpoint returned neither b64_json nor url.');
  }

  return { data, mimeType, revisedPrompt: first.revised_prompt };
}

/** Minimal HTTPS/HTTP GET that buffers the body (for URL-style image responses). */
function downloadBytes(
  url: string,
  allowSelfSigned: boolean | undefined,
  signal?: AbortSignal,
  apiKey?: string
): Promise<{ body: Buffer; mimeType: string }> {
  return new Promise((resolve, reject) => {
    let mod: typeof https | typeof import('http');
    try {
      mod = url.startsWith('https:') ? https : require('http');
    } catch {
      mod = https;
    }
    const reqOpts: https.RequestOptions = {};
    if (allowSelfSigned && url.startsWith('https:')) {
      reqOpts.agent = new https.Agent({ rejectUnauthorized: false });
    }
    if (apiKey) {
      reqOpts.headers = { Authorization: `Bearer ${apiKey}` };
    }
    const req = mod.get(url, reqOpts, (resp) => {
      if (!resp.statusCode || resp.statusCode >= 400) {
        reject(new Error(`Download failed: HTTP ${resp.statusCode}`));
        resp.resume();
        return;
      }
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () =>
        resolve({
          body: Buffer.concat(chunks),
          mimeType: String(resp.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
        })
      );
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Video generation profile (Seedance async task API)                  */
/* ------------------------------------------------------------------ */

export interface VideoConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  resolution: string;
  duration: string;
  allowSelfSignedCerts: boolean;
}

const DEFAULT_VIDEO_MODEL = 'seedance-1-0-pro-i2v';
const DEFAULT_VIDEO_RESOLUTION = '1280x720';
const DEFAULT_VIDEO_DURATION = '5';

/**
 * Resolve the video-generation profile. Each field falls back to the chat
 * profile when left empty, mirroring the image profile behaviour.
 */
export function readVideoConfig(): VideoConfig {
  const cfg = vscode.workspace.getConfiguration('burstcode.llm');
  const chat = readLLMConfig();
  const baseURL = (cfg.get<string>('video.baseURL') ?? '').trim();
  const apiKey = cfg.get<string>('video.apiKey');
  const model = (cfg.get<string>('video.model') ?? '').trim();
  const resolution = (cfg.get<string>('video.resolution') ?? '').trim();
  const duration = (cfg.get<string>('video.duration') ?? '').trim();
  const allow = cfg.get<boolean>('video.allowSelfSignedCerts');
  return {
    baseURL: baseURL || chat.baseURL,
    apiKey: typeof apiKey === 'string' && apiKey ? apiKey : chat.apiKey,
    model: model || DEFAULT_VIDEO_MODEL,
    resolution: resolution || DEFAULT_VIDEO_RESOLUTION,
    duration: duration || DEFAULT_VIDEO_DURATION,
    allowSelfSignedCerts:
      typeof allow === 'boolean' ? allow : chat.allowSelfSignedCerts === true
  };
}

export interface GeneratedVideo {
  /** Raw video bytes downloaded from the direct URL or /videos/{id}/content. */
  data: Buffer;
  /** Reported MIME type, defaults to video/mp4. */
  mimeType: string;
  /** The direct video URL or content endpoint used to fetch the bytes. */
  videoUrl: string;
}

interface VideoTaskResponse {
  id: string;
  model?: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | string;
  /** Direct video URL (OpenAI standard field). */
  url?: string;
  /** Alternative video URL field name used by some relays. */
  video_url?: string;
  error?: { code?: string; message?: string };
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ExtractedVideoResult {
  url?: string;
  data?: Buffer;
  mimeType?: string;
}

/** Small helper: resolve after ms, abortable via signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}

function normalizeVideoSize(size: string): string {
  const value = (size || '').trim().toLowerCase();
  if (value === '480p') return '854x480';
  if (value === '720p') return '1280x720';
  if (value === '1080p') return '1920x1080';
  return size || DEFAULT_VIDEO_RESOLUTION;
}

function normalizeVideoImageInput(imageUrl: string): unknown {
  const value = imageUrl.trim();
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (dataUrl) {
    return {
      bytesBase64Encoded: dataUrl[2].replace(/\s+/g, ''),
      mimeType: dataUrl[1]
    };
  }

  // If the caller provided a raw base64 image string, send the Vertex-compatible
  // object form instead of a bare string so BifrostLite can reliably map it to
  // instances[0].image.
  if (/^[a-z0-9+/=\s]{80,}$/i.test(value)) {
    return {
      bytesBase64Encoded: value.replace(/\s+/g, ''),
      mimeType: 'image/png'
    };
  }

  return value;
}

function tryDecodeBase64Video(value: string): ExtractedVideoResult | undefined {
  const trimmed = value.trim();
  const dataUrl = /^data:(video\/[a-z0-9.+-]+|application\/octet-stream);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
  if (dataUrl) {
    return {
      data: Buffer.from(dataUrl[2].replace(/\s+/g, ''), 'base64'),
      mimeType: dataUrl[1]
    };
  }
  if (/^[a-z0-9+/=\s]{80,}$/i.test(trimmed)) {
    return {
      data: Buffer.from(trimmed.replace(/\s+/g, ''), 'base64'),
      mimeType: 'video/mp4'
    };
  }
  return undefined;
}

function extractVideoResult(value: unknown, seen = new Set<unknown>()): ExtractedVideoResult | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^https?:\/\//i.test(text)) return { url: text };
    return tryDecodeBase64Video(text);
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const obj = value as Record<string, unknown>;
  const preferredKeys = [
    'url',
    'video_url',
    'videoUrl',
    'uri',
    'gcsUri',
    'signedUrl',
    'downloadUrl',
    'videoBytes',
    'video_bytes',
    'videoBytesBase64',
    'bytesBase64Encoded',
    'base64'
  ];
  for (const key of preferredKeys) {
    const found = extractVideoResult(obj[key], seen);
    if (found) return found;
  }
  for (const v of Object.values(obj)) {
    const found = extractVideoResult(v, seen);
    if (found) return found;
  }
  return undefined;
}

/** Generic JSON HTTP request (POST or GET) with Bearer auth. */
function httpJsonRequest<T>(
  url: string,
  method: 'GET' | 'POST',
  apiKey: string,
  body: string | undefined,
  allowSelfSigned: boolean | undefined,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    let mod: typeof https | typeof import('http');
    try {
      mod = url.startsWith('https:') ? https : require('http');
    } catch {
      mod = https;
    }
    const reqOpts: https.RequestOptions = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey || 'no-key'}`,
        'Content-Type': 'application/json'
      }
    };
    if (allowSelfSigned && url.startsWith('https:')) {
      (reqOpts as https.RequestOptions).agent = new https.Agent({
        rejectUnauthorized: false
      });
    }
    const req = mod.request(url, reqOpts, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!resp.statusCode || resp.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${resp.statusCode} from ${method} ${url}: ${text.slice(0, 500)}`
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new Error(`Invalid JSON response from ${method} ${url}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => req.destroy(new Error('aborted')),
        { once: true }
      );
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Generate a video via the OpenAI-compatible video generation API
 * (POST /videos → poll GET /videos/{id} → download).
 *
 * Supports text-to-video (t2v) and image-to-video (i2v) when `imageUrl`
 * is provided.
 */
export async function generateVideo(
  cfg: VideoConfig,
  prompt: string,
  opts: {
    imageUrl?: string;
    signal?: AbortSignal;
    /** Emit human-readable progress for long-running video tasks. */
    onProgress?: (msg: string) => void;
    /** Test hook: override poll interval; production default is 5 seconds. */
    pollIntervalMs?: number;
    /** Test hook: override max polling attempts; production default is 60 minutes. */
    maxAttempts?: number;
  } = {}
): Promise<GeneratedVideo> {
  const base = cfg.baseURL.replace(/\/+$/, '');
  const submitEndpoint = `${base}/videos`;

  // Build request body — OpenAI-compatible video format.  BifrostLite accepts
  // the first-frame image via the `image` field and translates it to
  // Vertex AI `instances[0].image` for ZenMux/Seedance providers.
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    seconds: parseInt(cfg.duration, 10) || 5,
    size: normalizeVideoSize(cfg.resolution)
  };
  if (opts.imageUrl) {
    body.image = normalizeVideoImageInput(opts.imageUrl);
  }

  // --- Step 1: submit the task ---
  const submitBody = JSON.stringify(body);
  const submitResp = await httpJsonRequest<{ id: string; status?: string }>(
    submitEndpoint,
    'POST',
    cfg.apiKey,
    submitBody,
    cfg.allowSelfSignedCerts,
    opts.signal
  );
  const videoId = submitResp.id;
  if (!videoId) {
    throw new Error('Video task submission returned no video id.');
  }
  opts.onProgress?.(`Video task ${videoId} submitted; polling status…`);

  // --- Step 2: poll until terminal state ---
  const pollUrl = `${base}/videos/${videoId}`;
  const intervalMs = opts.pollIntervalMs ?? 5000;
  const maxAttempts = opts.maxAttempts ?? Math.ceil((60 * 60 * 1000) / intervalMs);

  for (let i = 0; i < maxAttempts; i++) {
    if (opts.signal?.aborted) throw new Error('aborted');

    const task = await httpJsonRequest<VideoTaskResponse>(
      pollUrl,
      'GET',
      cfg.apiKey,
      undefined,
      cfg.allowSelfSignedCerts,
      opts.signal
    );

    const status = String(task.status || 'unknown');
    opts.onProgress?.(`Video task ${videoId}: ${status} (${i + 1}/${maxAttempts})…`);

    if (status === 'completed') {
      // Try direct URL/base64 data from the completed task response first, then
      // fall back to /videos/{id}/content. Some Vertex-compatible relays expose
      // the final asset only inside nested operation response fields.
      const extracted = extractVideoResult(task);
      if (extracted?.data) {
        opts.onProgress?.(`Video task ${videoId} completed; using embedded video data…`);
        return {
          data: extracted.data,
          mimeType: extracted.mimeType || 'video/mp4',
          videoUrl: pollUrl
        };
      }
      if (extracted?.url) {
        opts.onProgress?.(`Video task ${videoId} completed; downloading video…`);
        const fetched = await downloadBytes(
          extracted.url,
          cfg.allowSelfSignedCerts,
          opts.signal
        );
        return {
          data: fetched.body,
          mimeType: fetched.mimeType || extracted.mimeType || 'video/mp4',
          videoUrl: extracted.url
        };
      }
      // No URL in response — download from /videos/{id}/content (needs auth).
      const contentUrl = `${pollUrl}/content`;
      opts.onProgress?.(`Video task ${videoId} completed; downloading video content…`);
      const fetched = await downloadBytes(
        contentUrl,
        cfg.allowSelfSignedCerts,
        opts.signal,
        cfg.apiKey
      );
      return {
        data: fetched.body,
        mimeType: fetched.mimeType || 'video/mp4',
        videoUrl: contentUrl
      };
    }
    if (status === 'failed') {
      const errMsg = task.error?.message || 'unknown error';
      throw new Error(`Video generation failed: ${errMsg}`);
    }
    // status is 'queued' or 'in_progress' — keep polling
    if (i < maxAttempts - 1) {
      await sleep(intervalMs, opts.signal);
    }
  }

  const timeoutMinutes = Math.round((maxAttempts * intervalMs) / 60000);
  throw new Error(`Video generation timed out after ${timeoutMinutes} minutes of polling.`);
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
}): Promise<FetchedModelEntry[]> {
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
  const entries: FetchedModelEntry[] = res.data
    .filter((m) => typeof m.id === 'string' && !!m.id)
    .map((m) => {
      // Some gateways (e.g. OpenRouter, LiteLLM, One-API) expose a
      // `capabilities` object on the model record with boolean vision flags.
      const cap = (m as unknown as Record<string, unknown>).capabilities as
        | Record<string, unknown>
        | undefined;
      const supportsVision =
        !!cap?.vision ||
        !!cap?.images ||
        !!(cap?.input_modalities as string[] | undefined)?.includes('image');
      return { id: m.id, supportsVision };
    });
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/**
 * Persistent cache of `/v1/models` responses keyed by baseURL. Lives in the
 * extension's globalState so a fetched list survives webview reloads and
 * IDE restarts; the model picker can show the previously-fetched ids
 * immediately and only re-hit the network when the user clicks Refresh.
 */
const FETCHED_MODELS_CACHE_KEY = 'burstcode.llm.fetchedModelsCache.v1';

export interface FetchedModelEntry {
  id: string;
  supportsVision: boolean;
}

export interface FetchedModelsCacheEntry {
  models: FetchedModelEntry[];
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
  // Normalise: entries might be bare strings from an older cache version.
  const models: FetchedModelEntry[] = entry.models
    .map((m: unknown): FetchedModelEntry | null => {
      if (typeof m === 'string' && m) return { id: m, supportsVision: false };
      if (m && typeof (m as FetchedModelEntry).id === 'string' && (m as FetchedModelEntry).id)
        return m as FetchedModelEntry;
      return null;
    })
    .filter((m): m is FetchedModelEntry => m !== null);
  const fetchedAt = typeof entry.fetchedAt === 'number' ? entry.fetchedAt : 0;
  return { models, fetchedAt };
}

/** Persist a successful `/v1/models` response under the given baseURL. */
export async function writeCachedFetchedModels(
  memento: vscode.Memento,
  baseURL: string,
  models: FetchedModelEntry[]
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
        const openIdx = this.buf.indexOf(ThinkSplitter.OPEN);
        const closeIdx = this.buf.indexOf(ThinkSplitter.CLOSE);
        if (closeIdx >= 0 && (openIdx < 0 || closeIdx < openIdx)) {
          // Some OpenAI-compatible thinking gateways occasionally stream the
          // closing tag in `content` without the matching opening tag (often
          // after a retry/resume). Treat the prefix as hidden reasoning and
          // discard the stray marker so `</think>` never leaks into the visible
          // answer or persistent assistant content.
          const before = this.buf.slice(0, closeIdx);
          if (before) out.push({ reasoningDelta: before });
          this.buf = this.buf.slice(closeIdx + ThinkSplitter.CLOSE.length);
          continue;
        }
        if (openIdx >= 0) {
          const before = this.buf.slice(0, openIdx);
          if (before) out.push({ contentDelta: before });
          this.buf = this.buf.slice(openIdx + ThinkSplitter.OPEN.length);
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
function normalizeReasoningContent(messages: ChatMessage[], opts: { requireThinkingSeen?: boolean } = {}): ChatMessage[] {
  // Most providers only want reasoning_content backfilled after the session has
  // actually engaged thinking mode at least once. Unconditionally adding the
  // field to every assistant message can trigger "failed to marshal request body
  // to JSON" errors in Go-based API proxies that don't expect the extra field.
  const requireThinkingSeen = opts.requireThinkingSeen ?? true;
  const hasThinking = !requireThinkingSeen || messages.some((m) => {
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
 * DeepSeek's thinking-capable models have a stricter — and direction-dependent —
 * contract for `reasoning_content` than DashScope/Qwen:
 *
 *   1. Pure reasoning models (`deepseek-reasoner`, R1) do NOT support function
 *      calling and REJECT any history that still carries `reasoning_content`:
 *        400 "if the reasoning_content field is included in the sequence of
 *             input messages, the API will return a 400 error"
 *      → For these we STRIP `reasoning_content` from every assistant message.
 *
 *   2. Newer thinking models differ by generation/provider:
 *      - V3.x thinking models support function calling and require
 *        `reasoning_content` to round-trip on assistant tool-call turns; for
 *        plain assistant answers we strip it, matching DeepSeek's documented
 *        "previous-round CoT is not concatenated into the context" rule.
 *      - V4/Flash thinking providers can validate the whole assistant history
 *        once thinking mode is engaged and reject any assistant message without
 *        the field:
 *          400 "The `reasoning_content` in the thinking mode must be passed
 *               back to the API."
 *        → For V4/Flash models, use the generic thinking-mode backfill rule so
 *        every assistant message has `reasoning_content` when the session has
 *        ever captured non-empty reasoning.
 */
function normalizeDeepSeekReasoning(messages: ChatMessage[], model: string): ChatMessage[] {
  const lower = model.toLowerCase();
  // Pure reasoning models (R1 / deepseek-reasoner) cannot accept reasoning_content
  // at all and do not do tool calls — strip the field everywhere.
  const isPureReasoner = lower.includes('reasoner') || lower.includes('-r1') || lower.includes('/r1');
  if (isPureReasoner) return stripAssistantReasoningContent(messages);

  // DeepSeek V4/Flash thinking endpoints behave like Qwen-thinking validators:
  // after thinking mode appears in a session, every assistant message must carry
  // reasoning_content, even when the value is empty.
  const backfillAllAssistantReasoning = lower.includes('v4') || lower.includes('flash');
  if (backfillAllAssistantReasoning) return normalizeReasoningContent(messages, { requireThinkingSeen: false });

  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const am = m as ChatMessage & {
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    const hasToolCalls = Array.isArray(am.tool_calls) && am.tool_calls.length > 0;

    if (!hasToolCalls) {
      // Strip reasoning_content to match DeepSeek's "CoT not concatenated" rule
      // for plain answer turns on V3.x thinking models.
      if (typeof am.reasoning_content === 'undefined') return m;
      const { reasoning_content: _rc, ...rest } = am;
      return rest as ChatMessage;
    }

    // Thinking model + tool-call turn: reasoning_content MUST be present.
    if (typeof am.reasoning_content === 'string') return m;
    return { ...m, reasoning_content: '' } as ChatMessage;
  });
}

function stripAssistantReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const am = m as ChatMessage & { reasoning_content?: unknown };
    if (typeof am.reasoning_content === 'undefined') return m;
    const { reasoning_content: _rc, ...rest } = am;
    return rest as ChatMessage;
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
 * Gemini (OpenAI-compatible proxies that translate to Google GenerateContent):
 *   Strip `reasoning_content` entirely. It is an OpenAI-compatible extension used
 *   by Qwen/DeepSeek-style backends; Gemini's request schema rejects unknown
 *   message fields with a generic 400 INVALID_ARGUMENT.
 *
 * DeepSeek (deepseek-reasoner / V3.x thinking):
 *   Delegate to normalizeDeepSeekReasoning — strip reasoning_content for pure
 *   reasoners and plain answer turns, but round-trip it on tool-call turns of
 *   thinking models (see that function for the exact contract).
 *
 * All other models (Qwen/DashScope, …):
 *   Backfill `reasoning_content: ''` when the field is absent so Qwen-thinking
 *   endpoints always receive a shape-correct request body.
 */
function prepareMessagesForModel(messages: ChatMessage[], model: string): ChatMessage[] {
  const modelLower = model.toLowerCase();
  let out: ChatMessage[];
  if (modelLower.includes('claude')) {
    out = stripAssistantReasoningContent(messages).map((m) => {
      if (m.role !== 'assistant') return m;
      let msg: ChatMessage = m;
      // Strip thinking blocks that are missing a valid signature.
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
  } else if (modelLower.includes('gemini')) {
    out = stripAssistantReasoningContent(messages);
  } else if (modelLower.includes('deepseek')) {
    out = normalizeDeepSeekReasoning(messages, model);
  } else {
    out = normalizeReasoningContent(messages);
  }
  // FINAL pre-flight pass — runs for EVERY model at the single request
  // chokepoint. Per-model normalisation above can null out assistant content
  // or strip blocks, and (more importantly) the persistent history may have
  // been left with a dangling assistant `tool_calls` whose `tool` reply never
  // arrived — e.g. when a tool batch was cancelled mid-flight (AgentLoop's
  // `if (!result) continue`) or a stream was interrupted/auto-resumed before
  // the matching tool reply was pushed. Anthropic-style proxies reject such a
  // request with:
  //   400 unexpected `tool_use_id` found in `tool_result` blocks / each
  //       `tool_result` must have a corresponding `tool_use` in the previous
  //       message.
  // sanitizeToolPairing strips any unpaired tool_calls and orphan tool
  // replies so the body is always valid regardless of how history got here.
  return enforceToolCallPairing(out);
}

/**
 * Final defensive guarantee that the message list satisfies the strict
 * tool-call ↔ tool-result contract demanded by Anthropic-style backends:
 *   - every assistant `tool_calls` entry has a matching `tool` reply that
 *     comes immediately after it (ids that never get a reply are dropped), and
 *   - every `tool` reply references a `tool_call_id` declared on the directly
 *     preceding assistant message (orphans are dropped).
 *
 * This duplicates the intent of Compressor.sanitizeToolPairing but is applied
 * here as the LAST transform before the wire, so it also catches inconsistency
 * introduced AFTER compression (per-model rewriting) or by a persistent history
 * that was left dangling by a cancelled/interrupted turn.
 */
function enforceToolCallPairing(messages: ChatMessage[]): ChatMessage[] {
  type AssistantWithCalls = ChatMessage & {
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  };

  // Pass 1: for each assistant tool-call message, collect the set of ids that
  // are actually answered by `tool` replies in the contiguous run that follows
  // it (a run is broken by any assistant/user/system message).
  const answeredAt = new Map<number, Set<string>>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const calls = (m as AssistantWithCalls).tool_calls;
    if (!calls || calls.length === 0) continue;
    const ids = new Set(calls.map((c) => c.id));
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const r = messages[j];
      if (r.role !== 'tool') break; // run ends at the first non-tool message
      const id = (r as ChatMessage & { tool_call_id?: string }).tool_call_id;
      if (id && ids.has(id)) answered.add(id);
    }
    answeredAt.set(i, answered);
  }

  // Pass 2: rebuild, pruning unpaired tool_calls and orphan tool replies.
  const out: ChatMessage[] = [];
  let activeIds: Set<string> | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const calls = (m as AssistantWithCalls).tool_calls;
      if (calls && calls.length > 0) {
        const answered = answeredAt.get(i) ?? new Set<string>();
        const kept = calls.filter((c) => answered.has(c.id));
        if (kept.length === 0) {
          // No tool reply arrived: demote to a plain assistant message (or drop
          // it entirely if it has no visible content either).
          const rest = { ...(m as AssistantWithCalls) };
          delete rest.tool_calls;
          const hasText =
            typeof rest.content === 'string'
              ? rest.content.length > 0
              : Array.isArray(rest.content)
                ? rest.content.length > 0
                : false;
          if (hasText) out.push(rest as ChatMessage);
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
        activeIds.delete(id); // each id is answered at most once
      }
      // else: orphan tool reply — drop it.
    } else {
      out.push(m);
      if (m.role === 'user' || m.role === 'system') activeIds = null;
    }
  }
  // Some OpenAI-compatible gateways (e.g. MiniMax-M3 and other .NET-based
  // proxies) iterate `content` as a multimodal array and call LINQ on it,
  // throwing `Value cannot be null. (Parameter 'source')` when an assistant
  // tool_call message (whose content is legitimately null per the OpenAI
  // spec) or a tool reply carries `content: null`. Normalise those to "" so
  // the body never sends a null content the gateway can choke on.
  return out.map((m) => {
    if ((m.role === 'assistant' || m.role === 'tool') && m.content == null) {
      return { ...m, content: '' } as ChatMessage;
    }
    return m;
  });
}

export class OpenAIClient {
  private client: OpenAI;

  constructor(private readonly config: LLMConfig, private readonly logger: Logger) {
    const modelLower = config.model.toLowerCase();
    const isGemini = modelLower.includes('gemini');
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
    const modelLower = this.config.model.toLowerCase();
    const isGemini = modelLower.includes('gemini');
    const supportsTemperature = !modelLower.includes('claude');

    const buildRequest = (): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown> => ({
      model: this.config.model,
      messages: safeMessages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      // Encourage the model to batch independent tool calls into a single
      // assistant message. OpenAI GPT-4o / o-series default to true but
      // some OpenAI-compatible backends (DashScope, certain vLLM builds,
      // OpenRouter proxies) need this set explicitly to actually emit
      // multiple tool_calls per turn. Do not send it to Gemini translators:
      // native GenerateContentRequest has no equivalent field and may reject
      // the whole request as INVALID_ARGUMENT.
      parallel_tool_calls: tools.length && !isGemini ? true : undefined,
      ...(supportsTemperature ? { temperature: this.config.temperature } : {}),
      // Gemini OpenAI-compatible adapters may synthesize an invalid native
      // safety_settings default (seen as GenerateContentRequest.safety_settings[4]
      // category predicate failures). Send an explicit empty array on the FIRST
      // request so the adapter has no opportunity to inject that bad default.
      ...(isGemini ? { safety_settings: [] } : {}),
      stream: true
    });

    const streamSdkOnce = async function* (
      client: OpenAI,
      request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown>,
      signal: AbortSignal
    ): AsyncGenerator<StreamChunk, void, void> {
      const stream = await client.chat.completions.create(request, { signal });
      const splitter = new ThinkSplitter();

      for await (const part of stream) {
        const choice = part.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          for (const c of splitter.feed(delta.content)) yield c;
        }
        // Capture the chain-of-thought from whichever field the backend uses:
        // DeepSeek/Qwen-native use `reasoning_content`; OpenRouter and some
        // DeepSeek proxies stream it as `reasoning`. Losing it here means a
        // DeepSeek tool-call turn gets saved without its reasoning and the next
        // request 400s ("reasoning_content ... must be passed back").
        const d = delta as typeof delta & { reasoning_content?: string; reasoning?: string };
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (reasoning) {
          yield { reasoningDelta: reasoning };
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
    };

    const emitOpenAIStreamPart = function* (
      part: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> },
      splitter: ThinkSplitter
    ): Generator<StreamChunk, void, void> {
      const choice = part.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta?.content) {
        for (const c of splitter.feed(delta.content)) yield c;
      }
      const reasoning = delta?.reasoning_content;
      if (reasoning) yield { reasoningDelta: reasoning };
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
        for (const c of splitter.feed('', true)) yield c;
        yield { finishReason: choice.finish_reason };
      }
    };

    const toGeminiText = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return value
          .map((part) => {
            if (part && typeof part === 'object') {
              const p = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } };
              if (p.type === 'text') return String(p.text ?? '');
              if (p.type === 'image_url') {
                const url = typeof p.image_url?.url === 'string' ? p.image_url.url : '';
                const mime = /^data:([^;,]+)[;,]/i.exec(url)?.[1] || 'image';
                return `[attached image omitted from Gemini text-tool prompt: ${mime}; use the surrounding text note if a tool should consume the pasted image]`;
              }
            }
            return JSON.stringify(part);
          })
          .join('\n');
      }
      return value == null ? '' : JSON.stringify(value);
    };

    const buildGeminiTextToolMessages = (
      request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown>
    ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
      const rawMessages = (request.messages ?? []) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      const rawTools = Array.isArray(request.tools)
        ? (request.tools as OpenAI.Chat.Completions.ChatCompletionTool[])
        : [];
      if (rawTools.length === 0) return rawMessages;

      const catalog = rawTools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }));
      const dsmlInstructions =
        'GEMINI TEXT TOOL CALLING MODE (BurstCode compatibility): the native OpenAI `tools` field is intentionally omitted for Gemini/Bifrost because that adapter injects invalid GenerateContentRequest.safety_settings when native tool calling is enabled. When you need a tool, do NOT answer with prose only. Emit exactly one XML-like block in assistant text. Put the real tool arguments directly inside one JSON parameter named `arguments` (or use parameter names matching the tool schema):\n' +
        '<|DSML|tool_calls>\n' +
        '  <|DSML|invoke name="document_symbols">\n' +
        '    <|DSML|parameter name="arguments">{"path":"src/agent/AgentLoop.ts"}</|DSML|parameter>\n' +
        '  </|DSML|invoke>\n' +
        '</|DSML|tool_calls>\n' +
        'BurstCode will parse and execute this DSML block exactly like native tool_calls. Available tools:\n' +
        JSON.stringify(catalog);

      const converted = rawMessages.map((m) => {
        if (m.role === 'assistant') {
          const am = m as typeof m & { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
          if (Array.isArray(am.tool_calls) && am.tool_calls.length > 0) {
            const replay = am.tool_calls
              .map((tc) =>
                `<|DSML|invoke name="${tc.function?.name ?? ''}"><|DSML|parameter name="arguments" string="true">${tc.function?.arguments ?? '{}'}<\/|DSML|parameter><\/|DSML|invoke>`
              )
              .join('\n');
            return {
              role: 'assistant' as const,
              content: `${toGeminiText(am.content)}\n<|DSML|tool_calls>\n${replay}\n<\/|DSML|tool_calls>`.trim()
            };
          }
        }
        if (m.role === 'tool') {
          const tm = m as typeof m & { tool_call_id?: string };
          return {
            role: 'user' as const,
            content: `[tool result for ${tm.tool_call_id ?? 'unknown'}]\n${toGeminiText(tm.content)}`
          };
        }
        return m;
      });

      const firstSystem = converted.findIndex((m) => m.role === 'system');
      if (firstSystem >= 0) {
        const current = converted[firstSystem] as typeof converted[number] & { content?: unknown };
        converted[firstSystem] = {
          role: 'system' as const,
          content: `${toGeminiText(current.content)}\n\n${dsmlInstructions}`
        };
      } else {
        converted.unshift({ role: 'system', content: dsmlInstructions });
      }
      return converted;
    };

    const streamGeminiDirect = async function* (
      config: LLMConfig,
      request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & Record<string, unknown>,
      signal: AbortSignal
    ): AsyncGenerator<StreamChunk, void, void> {
      const base = config.baseURL.replace(/\/+$/, '');
      const endpoint = `${base}/chat/completions`;
      const body = JSON.stringify({
        ...request,
        messages: buildGeminiTextToolMessages(request),
        // Do not send native OpenAI tool fields to Gemini/Bifrost. The real
        // failing payload still had safety_settings: [] but Bifrost generated
        // invalid native GenerateContentRequest.safety_settings[4] when tools
        // were present. DSML text tool calls above avoid that adapter path.
        tools: undefined,
        tool_choice: undefined,
        parallel_tool_calls: undefined,
        safety_settings: []
      });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey || 'no-key'}`,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body,
        signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Gemini direct chat/completions HTTP ${res.status}: ${text}\n[sanitized_payload]\n${body}`);
      }
      if (!res.body) return;

      const splitter = new ThinkSplitter();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split(/\r?\n\r?\n/);
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
              .trim();
            if (!data || data === '[DONE]') continue;
            const part = JSON.parse(data) as Parameters<typeof emitOpenAIStreamPart>[0];
            for (const c of emitOpenAIStreamPart(part, splitter)) yield c;
          }
        }
        const tail = buf.trim();
        if (tail) {
          const data = tail
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (data && data !== '[DONE]') {
            const part = JSON.parse(data) as Parameters<typeof emitOpenAIStreamPart>[0];
            for (const c of emitOpenAIStreamPart(part, splitter)) yield c;
          }
        }
        for (const c of splitter.feed('', true)) yield c;
      } finally {
        reader.releaseLock();
      }
    };

    try {
      if (isGemini) {
        for await (const c of streamGeminiDirect(this.config, buildRequest(), ac.signal)) {
          yield c;
        }
        return;
      }

      for await (const c of streamSdkOnce(this.client, buildRequest(), ac.signal)) {
        yield c;
      }
    } finally {
      sub.dispose();
    }
  }
}
