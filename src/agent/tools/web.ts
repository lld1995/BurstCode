import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { Tool, ToolContext, ToolResult } from './types';
import { readChatProfile } from '../../llm/OpenAIClient';

const MAX_REDIRECTS = 6;
const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB cap on raw download
const DEFAULT_MAX_CHARS = 12_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; BurstCode-Agent/1.0; +https://github.com/lld1995/BurstCode)';

interface FetchResult {
  body: Buffer;
  mimeType: string;
  finalUrl: string;
  statusCode: number;
}

function getConfiguredProxyUrl(): string {
  return (vscode.workspace.getConfiguration('burstcode.web').get<string>('proxyUrl') ?? '').trim();
}


/** Read proxy URL from BurstCode/VS Code settings or process environment variables. */
export function getProxyUrl(): URL | null {
  // BurstCode setting takes highest priority for agent web tools.
  const burstProxy = getConfiguredProxyUrl();
  if (burstProxy) {
    try { return new URL(burstProxy); } catch { /* bad config, fall through */ }
  }

  // VS Code setting is still supported for users who already configured it globally.
  const vsCfg = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (vsCfg && vsCfg.trim()) {
    try { return new URL(vsCfg.trim()); } catch { /* bad config, fall through */ }
  }
  // Then environment variables (case-insensitive search)
  const envProxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY  ?? process.env.http_proxy;
  if (envProxy && envProxy.trim()) {
    try { return new URL(envProxy.trim()); } catch { /* bad value, fall through */ }
  }
  return null;
}

/**
 * Open a TCP connection to the proxy, issue HTTP CONNECT, then wrap the
 * resulting tunnel in TLS (for HTTPS targets).  Returns a ready-to-use
 * tls.TLSSocket so the caller can send plain HTTP/1.1 over it.
 */
export function openTunnel(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  useTls: boolean,
  cancellation?: vscode.CancellationToken
): Promise<tls.TLSSocket | net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyPort = parseInt(proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), 10);
    const proxyHost = proxy.hostname;
    const proxyAuth = proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
      : undefined;

    let settled = false;
    let activeSocket: net.Socket | tls.TLSSocket;
    let cancellationDisposable: vscode.Disposable | undefined;
    const socket = net.connect(proxyPort, proxyHost, () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        'Proxy-Connection: keep-alive',
      ];
      if (proxyAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    activeSocket = socket;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cancellationDisposable?.dispose();
      activeSocket.destroy();
      reject(err);
    };
    cancellationDisposable = cancellation?.onCancellationRequested(() => fail(new Error('Request cancelled')));
    if (cancellation?.isCancellationRequested) {
      fail(new Error('Request cancelled'));
      return;
    }

    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = buffered.slice(0, headerEnd).toString('ascii');
      const leftover = buffered.slice(headerEnd + 4);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.setTimeout(0);

      if (!/^HTTP\/1\.[01] 200/i.test(header)) {
        fail(new Error(`Proxy CONNECT rejected: ${header.split('\r\n')[0]}`));
        return;
      }

      if (settled) return;

      if (!useTls) {
        if (leftover.length > 0) socket.unshift(leftover);
        settled = true;
        cancellationDisposable?.dispose();
        resolve(socket);
        return;
      }

      // Do the TLS handshake over the raw CONNECT tunnel.
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: false,
      });
      activeSocket = tlsSocket;
      if (leftover.length > 0) tlsSocket.unshift(leftover);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        cancellationDisposable?.dispose();
        resolve(tlsSocket);
      });
      tlsSocket.once('error', fail);
    });

    socket.once('error', fail);
    socket.setTimeout(TIMEOUT_MS, () => fail(new Error('Proxy connection timed out')));
  });
}
export function fetchUrl(targetUrl: string, redirectsLeft = MAX_REDIRECTS, headers: Record<string, string> = {}, cancellation?: vscode.CancellationToken, requestBody?: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const targetPort = parseInt(parsed.port || (isHttps ? '443' : '80'), 10);
    const path = (parsed.pathname || '/') + (parsed.search || '');

    const reqHeaders: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/json,application/pdf,text/*;q=0.9,*/*;q=0.7',
      'Accept-Encoding': 'identity',
      'Connection': 'close',
      ...headers,
      ...(requestBody === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(requestBody)) }),
    };

    const handleResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, targetUrl).href; }
        catch { reject(new Error(`Redirect to invalid URL: ${res.headers.location}`)); return; }
        res.resume();
        fetchUrl(next, redirectsLeft - 1, headers, cancellation, requestBody).then(resolve).catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.on('end', () => resolve({
        body: Buffer.concat(chunks),
        mimeType: res.headers['content-type'] ?? '',
        finalUrl: targetUrl,
        statusCode: status,
      }));
      res.on('error', reject);
    };

    const proxy = getProxyUrl();

    if (proxy) {
      // openTunnel handles CONNECT + TLS; send plain HTTP/1.1 directly over the socket
      // instead of using http.request (which ignores createConnection and re-connects).
      openTunnel(proxy, parsed.hostname, targetPort, isHttps, cancellation)
        .then((socket) => {
          let settled = false;
          const settleReject = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancellationDisposable?.dispose();
            socket.destroy();
            reject(err);
          };
          const timer = setTimeout(() => settleReject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
          let cancellationDisposable: vscode.Disposable | undefined;
          cancellationDisposable = cancellation?.onCancellationRequested(() => settleReject(new Error('Request cancelled')));
          if (cancellation?.isCancellationRequested) {
            settleReject(new Error('Request cancelled'));
            return;
          }

          // Build raw HTTP/1.1 request
          const headerLines = Object.entries(reqHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n');
          const rawRequest = `${requestBody === undefined ? 'GET' : 'POST'} ${path} HTTP/1.1\r\nHost: ${parsed.hostname}\r\n${headerLines}\r\nConnection: close\r\n\r\n${requestBody ?? ''}`;

          const chunks: Buffer[] = [];
          socket.on('data', (chunk: Buffer) => chunks.push(chunk));
          socket.once('error', (e) => { settleReject(e); });
          socket.once('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cancellationDisposable?.dispose();
            const raw = Buffer.concat(chunks);
            const rawStr = raw.toString('binary');
            const headerEnd = rawStr.indexOf('\r\n\r\n');
            if (headerEnd < 0) { reject(new Error('Invalid HTTP response (no header end)')); return; }
            const headerSection = rawStr.slice(0, headerEnd);
            const bodyBuf = raw.slice(headerEnd + 4);
            const [statusLine, ...headerEntries] = headerSection.split('\r\n');
            const statusMatch = statusLine.match(/^HTTP\/[\d.]+ (\d+)/);
            if (!statusMatch) { reject(new Error(`Invalid HTTP status line: ${statusLine}`)); return; }
            const statusCode = parseInt(statusMatch[1], 10);
            const resHeaders: Record<string, string> = {};
            for (const line of headerEntries) {
              const idx = line.indexOf(':');
              if (idx > 0) resHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            }
            if (statusCode >= 300 && statusCode < 400 && resHeaders['location']) {
              if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
              let next: string;
              try { next = new URL(resHeaders['location'], targetUrl).href; }
              catch { reject(new Error(`Redirect to invalid URL: ${resHeaders['location']}`)); return; }
              fetchUrl(next, redirectsLeft - 1, headers, cancellation, requestBody).then(resolve).catch(reject);
              return;
            }
            resolve({
              body: bodyBuf,
              mimeType: resHeaders['content-type'] ?? '',
              finalUrl: targetUrl,
              statusCode,
            });
          });

          socket.write(rawRequest);
        })
        .catch(reject);
    } else {
      // Direct connection
      const requester: typeof https | typeof http = isHttps ? https : http;
      const req = requester.request({
        hostname: parsed.hostname,
        port: targetPort,
        path,
        method: requestBody === undefined ? 'GET' : 'POST',
        headers: reqHeaders,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      }, handleResponse);
      let settled = false;
      let cancellationDisposable: vscode.Disposable | undefined;
      const rejectAndDestroy = (err: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        cancellationDisposable?.dispose();
        reject(err);
      };
      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        cancellationDisposable?.dispose();
        reject(err);
      });
      req.on('timeout', () => rejectAndDestroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)));
      cancellationDisposable = cancellation?.onCancellationRequested(() => rejectAndDestroy(new Error('Request cancelled')));
      if (cancellation?.isCancellationRequested) {
        rejectAndDestroy(new Error('Request cancelled'));
        return;
      }
      req.end(requestBody);
    }
  });
}

// ---------------------------------------------------------------------------
// HTML → plain text + link extraction
// ---------------------------------------------------------------------------

export function htmlToText(
  html: string,
  baseUrl: string
): { text: string; links: Array<{ text: string; url: string }> } {
  // ---- strip noisy blocks first ----
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // ---- extract hyperlinks before stripping tags ----
  const links: Array<{ text: string; url: string }> = [];
  const seenUrls = new Set<string>();
  const linkRe = /<a\s[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(s)) !== null) {
    try {
      const abs = new URL(m[1].trim(), baseUrl).href;
      if (
        !seenUrls.has(abs) &&
        !abs.startsWith('javascript:') &&
        !abs.startsWith('mailto:') &&
        !abs.startsWith('data:')
      ) {
        seenUrls.add(abs);
        const lt = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (lt.length > 0) links.push({ text: lt.slice(0, 120), url: abs });
      }
    } catch {
      // ignore malformed href
    }
  }

  // ---- block elements → newlines ----
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/article>/gi, '\n')
    .replace(/<\/section>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t');

  // ---- strip all remaining tags ----
  s = s.replace(/<[^>]+>/g, '');

  // ---- decode HTML entities ----
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/(?:&#39;|&apos;)/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // ---- normalise whitespace ----
  const text = s
    .replace(/\t+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, links };
}

// ---------------------------------------------------------------------------
// Minimal PDF text extraction (Tj / TJ operators, uncompressed streams only)
// ---------------------------------------------------------------------------

function extractPdfText(buf: Buffer): string {
  // Work with latin1 so binary bytes don't get mangled
  const raw = buf.toString('latin1');
  const lines: string[] = [];

  // We only attempt uncompressed streams (no /Filter or /Filter /Identity)
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let sm: RegExpExecArray | null;
  while ((sm = streamRe.exec(raw)) !== null) {
    const block = sm[1];
    // Tf / Td operators indicate text-layout content — skip binary image streams
    if (!/\bTf\b/.test(block) && !/\bBT\b/.test(block)) continue;

    // (string) Tj
    const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
    let tm: RegExpExecArray | null;
    while ((tm = tjRe.exec(block)) !== null) {
      lines.push(decodePdfString(tm[1]));
    }
    // [(string|num)...] TJ
    const tjArrRe = /\[((?:[^[\]]*(?:\([^)]*\))?[^[\]]*)*)\]\s*TJ/g;
    while ((tm = tjArrRe.exec(block)) !== null) {
      const items = tm[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) ?? [];
      for (const it of items) lines.push(decodePdfString(it.slice(1, -1)));
    }
  }

  if (lines.length === 0) {
    return '(PDF text extraction failed — file may use compressed streams or CID fonts; try converting to text first)';
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/(?:&#39;|&apos;)/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// web_search — gateway REST API
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function summarizeResponseBody(body: string, maxChars = 500): string {
  const raw = body.trim();
  if (!raw) return '';
  try {
    const json = JSON.stringify(JSON.parse(raw));
    return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
  } catch {
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
}

function normalizeSearchResults(payload: unknown, maxResults: number): SearchResult[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(root.results) ? root.results : Array.isArray(root.data) ? root.data : [];
  return raw.map((item) => {
    const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      title: String(value.title ?? value.name ?? '').trim(),
      url: String(value.url ?? value.link ?? '').trim(),
      snippet: String(value.snippet ?? value.description ?? value.content ?? '').trim()
    };
  }).filter((item) => item.title && /^https?:\/\//i.test(item.url)).slice(0, maxResults);
}

async function gatewaySearch(query: string, maxResults: number, cancellation?: vscode.CancellationToken): Promise<SearchResult[]> {
  const web = vscode.workspace.getConfiguration('burstcode.web');
  const configuredBase = (web.get<string>('searchBaseURL') ?? '').trim();
  const inheritChatConfig = web.get<boolean>('inheritChatConfig') !== false;
  const chat = inheritChatConfig ? await readChatProfile() : undefined;
  const baseURL = inheritChatConfig ? (chat?.baseURL ?? '') : configuredBase;
  const apiKey = inheritChatConfig ? (chat?.apiKey ?? '').trim() : (web.get<string>('searchApiKey') ?? '').trim();
  if (!baseURL) throw new Error('No web-search gateway URL configured');
  if (!apiKey) throw new Error(inheritChatConfig
    ? 'No chat API key configured for inherited web search'
    : 'No dedicated web-search API key configured');

  const response = await fetchUrl(`${baseURL.replace(/\/+$/, '')}/web_search`, MAX_REDIRECTS, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  }, cancellation, JSON.stringify({ query, count: maxResults }));
  const text = response.body.toString('utf-8');
  if (response.statusCode >= 400) throw new Error(`gateway returned HTTP ${response.statusCode}${summarizeResponseBody(text) ? ` — ${summarizeResponseBody(text)}` : ''}`);
  const results = normalizeSearchResults(JSON.parse(text), maxResults);
  return results;
}

export const webSearchTool: Tool = {
  name: 'web_search',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Retrieve public external information through the configured gateway REST API, returning result titles, URLs, and snippets. Use when answering requires evidence from the public web rather than private account data. After getting results, call read_webpage with a specific URL to read the full content.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          maxResults: { type: 'number', description: 'Maximum number of results to return (default 8, max 20).' }
        },
        required: ['query']
      }
    }
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { content: 'web_search: query is required', isError: true };
    const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 8), 20);
    ctx.emitProgress(`Searching: ${query} …`);
    try {
      const results = await gatewaySearch(query, maxResults, ctx.cancellation);
      if (ctx.cancellation.isCancellationRequested) return { content: 'web_search: cancelled', isError: true };
      const lines = results.map((result, index) => `${index + 1}. **${result.title}**\n   URL: ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`);
      return { content: `# Web search: "${query}" (${results.length} results)\n\n${lines.join('\n\n')}`, meta: { query, count: results.length } };
    } catch (err) {
      return { content: `web_search: search failed — ${String((err as Error).message ?? err)}`, isError: true };
    }
  }
};

// ---------------------------------------------------------------------------
// Tool definition — read_webpage
// ---------------------------------------------------------------------------

export const readWebpageTool: Tool = {
  name: 'read_webpage',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'read_webpage',
      description:
        'Fetch a URL and return its text content (HTML converted to readable text, PDF text extracted). ' +
        'Also returns a list of hyperlinks found on the page so you can follow up with another call. ' +
        'Use this when the user provides a documentation URL, API reference, GitHub page, or any web resource. ' +
        'For following links: call read_webpage again with the specific link URL from the returned `links` list.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (http:// or https://).'
          },
          maxChars: {
            type: 'number',
            description: `Maximum characters of text content to return (default ${DEFAULT_MAX_CHARS}, max 40000).`
          },
          extractLinks: {
            type: 'boolean',
            description: 'Whether to return the list of hyperlinks found on the page (default true). Set false to save tokens when you only need the text.'
          }
        },
        required: ['url']
      }
    }
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args.url ?? '').trim();
    if (!url) return { content: 'read_webpage: url is required', isError: true };
    if (!/^https?:\/\//i.test(url)) {
      return { content: `read_webpage: URL must start with http:// or https:// (got: ${url})`, isError: true };
    }

    const maxChars = Math.min(Math.max(500, Number(args.maxChars) || DEFAULT_MAX_CHARS), 40_000);
    const doLinks = args.extractLinks !== false;

    ctx.emitProgress(`Fetching ${url} …`);

    let result: FetchResult;
    try {
      result = await fetchUrl(url, MAX_REDIRECTS, {}, ctx.cancellation);
    } catch (err) {
      return { content: `read_webpage: fetch failed — ${String((err as Error).message ?? err)}`, isError: true };
    }

    if (ctx.cancellation.isCancellationRequested) {
      return { content: 'read_webpage: cancelled', isError: true };
    }

    const { body, mimeType, finalUrl, statusCode } = result;

    if (statusCode >= 400) {
      return {
        content: `read_webpage: server returned HTTP ${statusCode} for ${finalUrl}`,
        isError: true
      };
    }

    const mime = mimeType.toLowerCase();
    let text: string;
    let links: Array<{ text: string; url: string }> = [];

    if (mime.includes('pdf') || (body.length >= 4 && body.slice(0, 4).toString('ascii') === '%PDF')) {
      ctx.emitProgress('Extracting PDF text …');
      text = extractPdfText(body);
    } else if (mime.includes('html') || mime.includes('xhtml') || mime.includes('xml')) {
      const charset = mime.match(/charset=([^\s;]+)/i)?.[1] ?? 'utf-8';
      let htmlStr: string;
      try {
        htmlStr = body.toString(charset as BufferEncoding);
      } catch {
        htmlStr = body.toString('utf-8');
      }
      const parsed = htmlToText(htmlStr, finalUrl);
      text = parsed.text;
      if (doLinks) links = parsed.links;
    } else if (mime.includes('text/')) {
      text = body.toString('utf-8');
    } else {
      return {
        content: `read_webpage: unsupported content type "${mimeType}" at ${finalUrl}. This tool only handles HTML, plain text, and PDF.`,
        isError: true
      };
    }

    // Truncate if needed
    let truncatedNote = '';
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      // Don't cut mid-word
      const lastSpace = text.lastIndexOf(' ');
      if (lastSpace > maxChars - 200) text = text.slice(0, lastSpace);
      truncatedNote = `\n\n[Content truncated at ${maxChars} chars. Call again with a higher maxChars or follow specific links.]`;
    }

    let linksSection = '';
    if (doLinks && links.length > 0) {
      // Cap at 60 most-relevant links to avoid token waste
      const shown = links.slice(0, 60);
      linksSection =
        '\n\n## Links found on this page\n' +
        shown.map((l) => `- [${l.text}](${l.url})`).join('\n') +
        (links.length > shown.length ? `\n… and ${links.length - shown.length} more` : '');
    }

    return {
      content: `# ${finalUrl}\n\n${text}${truncatedNote}${linksSection}`,
      meta: { url: finalUrl, statusCode, mimeType, chars: text.length, linkCount: links.length }
    };
  }
};
