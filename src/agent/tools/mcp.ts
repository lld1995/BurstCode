import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Tool, ToolContext, ToolResult, ToolSchema } from './types';
import { Logger } from '../../util/Logger';

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

type McpToolEntry = {
  server: string;
  remoteName: string;
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpConnection = {
  cfg: McpServerConfig;
  client: Client;
  tools: McpToolEntry[];
  transport: unknown;
};

const MCP_TOOL_PREFIX = 'mcp__';
const DEFAULT_TIMEOUT_MS = 60_000;
const connections = new Map<string, Promise<McpConnection>>();
const lastConfigKeys = new Set<string>();

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function substituteVars(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value;
  const root = workspaceRoot() ?? '';
  return value.replace(/\$\{workspaceFolder\}/g, root);
}

function sanitizePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'server';
}

function exposedToolName(server: string, remoteName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizePart(server)}__${sanitizePart(remoteName)}`.slice(0, 64);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = substituteVars(v) ?? v;
  }
  return out;
}

// Flatten a { name: cfg } map (the standard `mcpServers` object form) into
// flat entries. A `name` field on the value wins over the map key.
function flattenServerMap(map: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!isObject(value)) continue;
    const ownName = typeof value.name === 'string' && value.name.trim() ? value.name : key;
    out.push({ ...value, name: ownName });
  }
  return out;
}

// Accept three shapes for `burstcode.mcp.servers`:
//   1. flat array of server objects   — [ { name, url } ]                (native)
//   2. standard object map            — { mcpServers: { name: cfg } } or { name: cfg }
//   3. array containing a wrapper      — [ { mcpServers: { name: cfg } } ]
// All are normalized to a flat array of entries that each carry a `name`.
function normalizeMcpEntries(raw: unknown): Record<string, unknown>[] {
  if (isObject(raw)) {
    return flattenServerMap(isObject(raw.mcpServers) ? raw.mcpServers : raw);
  }
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (isObject(item.mcpServers)) {
      out.push(...flattenServerMap(item.mcpServers));
      continue;
    }
    out.push(item);
  }
  return out;
}

export function readMcpServerConfigs(): McpServerConfig[] {
  const raw = vscode.workspace.getConfiguration('burstcode.mcp').get<unknown>('servers');
  const entries = normalizeMcpEntries(raw);
  if (entries.length === 0) return [];
  const seen = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const item of entries) {
    const nameRaw = typeof item.name === 'string' ? item.name.trim() : '';
    if (!nameRaw) continue;
    const name = sanitizePart(nameRaw);
    if (seen.has(name)) continue;
    seen.add(name);
    const command = substituteVars(typeof item.command === 'string' ? item.command.trim() : undefined);
    const url = substituteVars(typeof item.url === 'string' ? item.url.trim() : undefined);
    if (!command && !url) continue;
    out.push({
      name,
      command,
      url,
      args: readStringArray(item.args).map((a) => substituteVars(a) ?? a),
      env: readStringRecord(item.env),
      cwd: substituteVars(typeof item.cwd === 'string' ? item.cwd.trim() : undefined),
      headers: readStringRecord(item.headers),
      disabled: item.disabled === true
    });
  }
  return out.filter((cfg) => !cfg.disabled);
}

function configKey(cfg: McpServerConfig): string {
  return JSON.stringify({
    name: cfg.name,
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: cfg.cwd,
    url: cfg.url,
    headers: cfg.headers ?? {}
  });
}

function mcpToolId(server: string, remoteName: string): string {
  return `${server}.${remoteName}`;
}

export function readMcpEnabledToolNames(): string[] | undefined {
  const raw = vscode.workspace.getConfiguration('burstcode.mcp').get<unknown>('enabledTools');
  if (raw == null) return undefined;
  const list = readStringArray(raw).map((t) => t.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function mcpEnabledToolSet(): Set<string> | undefined {
  const enabled = readMcpEnabledToolNames();
  return enabled === undefined ? undefined : new Set(enabled);
}

function isMcpToolEnabled(entry: McpToolEntry, enabled: Set<string> | undefined): boolean {
  if (!enabled) return true;
  return enabled.has(entry.remoteName) || enabled.has(mcpToolId(entry.server, entry.remoteName)) || enabled.has(entry.exposedName);
}

async function closeTransport(transport: unknown): Promise<void> {
  const maybe = transport as { close?: () => Promise<void> | void } | undefined;
  if (typeof maybe?.close === 'function') {
    try { await maybe.close(); } catch { /* ignore */ }
  }
}

function makeClient(serverName: string): Client {
  return new Client({ name: `burstcode-${serverName}`, version: '0.1.0' }, { capabilities: {} });
}

async function connectServer(cfg: McpServerConfig, logger: Logger): Promise<McpConnection> {
  let client = makeClient(cfg.name);
  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  if (cfg.url) {
    const url = new URL(cfg.url);
    const headers = cfg.headers && Object.keys(cfg.headers).length > 0 ? cfg.headers : undefined;
    try {
      transport = new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined);
      await client.connect(transport);
    } catch (err) {
      logger.warn(`MCP ${cfg.name}: streamable HTTP connect failed, trying SSE`, String(err));
      await closeTransport(transport!);
      // Use a fresh client for the SSE attempt: the first connect() may have
      // partially initialized this client (handlers installed during the failed
      // handshake), so reusing it can carry stale state into the retry.
      client = makeClient(cfg.name);
      transport = new SSEClientTransport(url, headers ? { requestInit: { headers } } : undefined);
      await client.connect(transport);
    }
  } else if (cfg.command) {
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      cwd: cfg.cwd || workspaceRoot()
    });
    await client.connect(transport);
  } else {
    throw new Error(`MCP server ${cfg.name} has neither command nor url.`);
  }

  const listed = await client.listTools();
  const tools = (listed.tools ?? []).map((t) => ({
    server: cfg.name,
    remoteName: t.name,
    exposedName: exposedToolName(cfg.name, t.name),
    description: t.description || `MCP tool ${t.name} from server ${cfg.name}.`,
    inputSchema: isObject(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} }
  }));
  logger.info(`MCP ${cfg.name}: connected with ${tools.length} tool(s).`);
  return { cfg, client, tools, transport };
}

async function getConnection(cfg: McpServerConfig, logger: Logger): Promise<McpConnection> {
  const key = configKey(cfg);
  lastConfigKeys.add(key);
  let existing = connections.get(key);
  if (!existing) {
    existing = connectServer(cfg, logger).catch((err) => {
      connections.delete(key);
      throw err;
    });
    connections.set(key, existing);
  }
  return existing;
}

// Drop a cached connection AND close its transport. Deleting from the map
// without closing leaks the underlying socket (HTTP/SSE) or child process
// (stdio), since buildMcpTools' cleanup pass only closes connections still
// present in the map.
function evictConnection(key: string): void {
  const conn = connections.get(key);
  connections.delete(key);
  lastConfigKeys.delete(key);
  if (conn) void conn.then((c) => closeTransport(c.transport), () => { /* connect already failed */ });
}

// Bridge a VS Code CancellationToken to an AbortSignal so the MCP SDK can
// actually abort the in-flight JSON-RPC request, not just reject our wrapper.
function cancellationToSignal(token: vscode.CancellationToken | undefined): AbortSignal | undefined {
  if (!token) return undefined;
  if (token.isCancellationRequested) return AbortSignal.abort();
  const ctrl = new AbortController();
  token.onCancellationRequested(() => ctrl.abort());
  return ctrl.signal;
}

function stringifyMcpContent(value: unknown): string {
  if (!isObject(value)) return value == null ? '' : JSON.stringify(value);
  const content = value.content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (!isObject(part)) return String(part);
      if (typeof part.text === 'string') return part.text;
      if (typeof part.data === 'string') return `[${String(part.type ?? 'data')}] ${part.data}`;
      return JSON.stringify(part);
    }).filter(Boolean);
    const rest = { ...value };
    delete rest.content;
    const suffix = Object.keys(rest).length > 0 ? `\n${JSON.stringify(rest)}` : '';
    return `${parts.join('\n')}${suffix}`.trim();
  }
  return JSON.stringify(value, null, 2);
}

function mcpToolSchema(entry: McpToolEntry): ToolSchema {
  return {
    type: 'function',
    function: {
      name: entry.exposedName,
      description: `[MCP:${entry.server}] ${entry.description}`,
      parameters: {
        type: 'object',
        properties: isObject(entry.inputSchema.properties) ? entry.inputSchema.properties : {},
        required: Array.isArray(entry.inputSchema.required) ? entry.inputSchema.required as string[] : undefined
      }
    }
  };
}

function listMcpToolsSchema(): ToolSchema {
  return {
    type: 'function',
    function: {
      name: 'list_mcp_tools',
      description: 'List all tools discovered from configured MCP servers and whether each one is enabled for agent use.',
      parameters: { type: 'object', properties: {} }
    }
  };
}

export type McpToolInventoryItem = {
  server: string;
  name: string;
  exposedName: string;
  enabled: boolean;
  description: string;
};

export async function listMcpToolInventory(logger: Logger): Promise<McpToolInventoryItem[]> {
  const configs = readMcpServerConfigs();
  const enabled = mcpEnabledToolSet();
  const inventory: McpToolInventoryItem[] = [];
  for (const cfg of configs) {
    try {
      const conn = await getConnection(cfg, logger);
      for (const entry of conn.tools) {
        inventory.push({
          server: entry.server,
          name: entry.remoteName,
          exposedName: entry.exposedName,
          enabled: isMcpToolEnabled(entry, enabled),
          description: entry.description
        });
      }
    } catch (err) {
      logger.warn(`MCP ${cfg.name}: failed to list tools`, String(err));
      inventory.push({ server: cfg.name, name: '(connection failed)', exposedName: '', enabled: false, description: String(err) });
    }
  }
  return inventory;
}

export async function buildMcpTools(logger: Logger): Promise<Tool[]> {
  const configs = readMcpServerConfigs();
  const activeKeys = new Set(configs.map(configKey));
  for (const key of Array.from(lastConfigKeys)) {
    if (activeKeys.has(key)) continue;
    lastConfigKeys.delete(key);
    const conn = connections.get(key);
    connections.delete(key);
    if (conn) void conn.then((c) => closeTransport(c.transport));
  }

  const tools: Tool[] = [{
    name: 'list_mcp_tools',
    schema: listMcpToolsSchema(),
    parallelSafe: false,
    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (configs.length === 0) return { content: 'No MCP servers configured.', meta: { servers: [] } };
      const inventory = await listMcpToolInventory(logger);
      const content = inventory.length > 0
        ? inventory.map((t) => `${t.enabled ? '✓' : '○'} ${mcpToolId(t.server, t.name)}${t.exposedName ? ` (${t.exposedName})` : ''} — ${t.description}`).join('\n')
        : 'No MCP tools discovered.';
      return { content, meta: { tools: inventory } };
    }
  }];
  if (configs.length === 0) return tools;

  const enabled = mcpEnabledToolSet();
  for (const cfg of configs) {
    let conn: McpConnection;
    try {
      conn = await getConnection(cfg, logger);
    } catch (err) {
      logger.warn(`MCP ${cfg.name}: failed to connect`, String(err));
      continue;
    }
    for (const entry of conn.tools) {
      if (!isMcpToolEnabled(entry, enabled)) continue;
      tools.push({
        name: entry.exposedName,
        schema: mcpToolSchema(entry),
        parallelSafe: false,
        async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
          try {
            ctx.emitProgress(`Calling MCP ${entry.server}.${entry.remoteName}…`);
            const latest = await getConnection(cfg, logger);
            // Pass signal + timeout to the SDK so a cancel/timeout actually
            // aborts the underlying JSON-RPC request server-side, instead of
            // only rejecting a wrapper while the request keeps running.
            const result = await latest.client.callTool(
              { name: entry.remoteName, arguments: args },
              undefined,
              { signal: cancellationToSignal(ctx.cancellation), timeout: DEFAULT_TIMEOUT_MS }
            );
            const isError = isObject(result) && result.isError === true;
            return {
              content: stringifyMcpContent(result),
              isError,
              meta: { server: entry.server, tool: entry.remoteName }
            };
          } catch (err) {
            // Transport may be in a bad state after a failed/aborted call;
            // evict (and close) so the next call reconnects cleanly.
            evictConnection(configKey(cfg));
            return {
              content: `MCP tool ${entry.server}.${entry.remoteName} failed: ${String(err)}`,
              isError: true
            };
          }
        }
      });
    }
  }
  return tools;
}
