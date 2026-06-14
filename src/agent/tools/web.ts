import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { Tool, ToolContext, ToolResult } from './types';

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

function getBraveApiKey(): string {
  return (vscode.workspace.getConfiguration('burstcode.web').get<string>('braveApiKey') ?? '').trim();
}

/** Read proxy URL from BurstCode/VS Code settings or process environment variables. */
function getProxyUrl(): URL | null {
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
 * Open a raw socket to the proxy and issue a CONNECT tunnel to target.
 * Returns a TLS socket (for HTTPS targets) or plain socket (for HTTP targets).
 */
function openTunnel(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  useTls: boolean
): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const proxyPort = parseInt(proxy.port || '8080', 10);
    const proxyHost = proxy.hostname;

    const socket = net.connect(proxyPort, proxyHost, () => {
      const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      socket.write(connectReq);

      let response = '';
      socket.once('data', (chunk) => {
        response += chunk.toString('ascii');
        // 200 Connection established → tunnel is open
        if (/^HTTP\/1\.[01] 200/i.test(response)) {
          if (useTls) {
            const tlsSocket = tls.connect({
              socket,
              servername: targetHost,
              rejectUnauthorized: false,
            });
            tlsSocket.once('secureConnect', () => resolve(tlsSocket));
            tlsSocket.once('error', reject);
          } else {
            resolve(socket);
          }
        } else {
          socket.destroy();
          const status = response.split('\r\n')[0];
          reject(new Error(`Proxy CONNECT rejected: ${status}`));
        }
      });
      socket.once('error', reject);
    });
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('Proxy connection timed out'));
    });
    socket.once('error', reject);
  });
}

function fetchUrl(targetUrl: string, redirectsLeft = MAX_REDIRECTS, headers: Record<string, string> = {}): Promise<FetchResult> {
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
    };

    const handleResponse = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, targetUrl).href; }
        catch { reject(new Error(`Redirect to invalid URL: ${res.headers.location}`)); return; }
        res.resume();
        fetchUrl(next, redirectsLeft - 1, headers).then(resolve).catch(reject);
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
      // Route through proxy tunnel; inject the pre-connected socket via createConnection
      openTunnel(proxy, parsed.hostname, targetPort, isHttps)
        .then((socket) => {
          const requester: typeof https | typeof http = isHttps ? https : http;
          // createConnection signature: (opts, oncreate) => net.Socket
          // We ignore opts/oncreate and return our existing socket synchronously.
          const createConnection = () => socket as net.Socket;
          const req = requester.request(
            Object.assign({
              hostname: parsed.hostname,
              port: targetPort,
              path,
              method: 'GET',
              headers: reqHeaders,
              rejectUnauthorized: false,
              timeout: TIMEOUT_MS,
            }, { createConnection }) as https.RequestOptions,
            handleResponse
          );
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
          req.end();
        })
        .catch(reject);
    } else {
      // Direct connection
      const requester: typeof https | typeof http = isHttps ? https : http;
      const req = requester.request({
        hostname: parsed.hostname,
        port: targetPort,
        path,
        method: 'GET',
        headers: reqHeaders,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      }, handleResponse);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
      req.end();
    }
  });
}

// ---------------------------------------------------------------------------
// HTML → plain text + link extraction
// ---------------------------------------------------------------------------

function htmlToText(
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
// web_search — DuckDuckGo HTML scrape (no API key needed)
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function fetchSearchPage(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetchUrl(url, MAX_REDIRECTS, headers);
  if (res.statusCode >= 400) {
    const detail = summarizeResponseBody(res.body.toString('utf-8'));
    throw new Error(`search provider returned HTTP ${res.statusCode}${detail ? ` — ${detail}` : ''}`);
  }
  return res.body.toString('utf-8');
}

function summarizeResponseBody(body: string, maxChars = 500): string {
  const raw = body.trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw) as unknown;
    const json = JSON.stringify(parsed);
    return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
  } catch {
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
}

function describeBraveStatus(statusCode: number): string {
  switch (statusCode) {
    case 400:
    case 422:
      return 'bad request / invalid query parameters';
    case 401:
      return 'API key is invalid or missing';
    case 403:
      return 'API key is not allowed to access Brave Search, or the subscription is inactive';
    case 408:
      return 'request timed out';
    case 429:
      return 'rate limit or monthly quota exhausted';
    default:
      if (statusCode >= 500) return 'Brave Search server error';
      return 'unexpected Brave Search response';
  }
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Each result block: <div class="result ..."> contains <a class="result__a"> and <a class="result__snippet">
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null && results.length < maxResults) {
    const block = bm[1];

    // Extract href from result__a (DDG uses redirect URLs — extract uddg param for real URL)
    const linkM = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkM) continue;

    let url = linkM[1];
    // DDG wraps real URLs in /l/?uddg=<encoded>
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { url = decodeURIComponent(uddg[1]); } catch { /* keep original */ }
    }
    if (url.startsWith('/')) {
      try { url = new URL(url, 'https://duckduckgo.com').href; } catch { continue; }
    }
    if (!url.startsWith('http')) continue;

    const title = decodeHtmlEntities(linkM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

    // Snippet
    const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippet = snipM
      ? decodeHtmlEntities(snipM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      : '';

    if (title && url) results.push({ title, url, snippet });
  }

  return results;
}

function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<li\s+class="b_algo"[^>]*>([\s\S]*?)(?=<li\s+class="b_algo"|<\/ol>|<\/main>|$)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) !== null && results.length < maxResults) {
    const block = bm[1];
    const linkM = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block);
    if (!linkM) continue;

    const url = decodeHtmlEntities(linkM[1]);
    if (!url.startsWith('http')) continue;

    const title = decodeHtmlEntities(linkM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const snipM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = snipM
      ? decodeHtmlEntities(snipM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      : '';

    if (title && url) results.push({ title, url, snippet });
  }
  return results;
}

function parseBraveResults(json: string, maxResults: number): SearchResult[] {
  const payload = JSON.parse(json) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const raw = payload.web?.results ?? [];
  return raw
    .map((r) => ({
      title: decodeHtmlEntities(String(r.title ?? '').replace(/<[^>]+>/g, '').trim()),
      url: String(r.url ?? '').trim(),
      snippet: decodeHtmlEntities(String(r.description ?? '').replace(/<[^>]+>/g, '').trim()),
    }))
    .filter((r) => r.title && r.url.startsWith('http'))
    .slice(0, maxResults);
}

async function duckduckgoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const braveKey = getBraveApiKey();
  const attempts: Array<{
    name: string;
    url: string;
    headers?: Record<string, string>;
    parse: (body: string, maxResults: number) => SearchResult[];
  }> = [];

  if (braveKey) {
    attempts.push({
      name: 'Brave Search',
      url: `https://api.search.brave.com/res/v1/web/search?q=${encoded}`,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveKey,
      },
      parse: parseBraveResults,
    });
  }

  attempts.push(
    { name: 'DuckDuckGo HTML', url: `https://html.duckduckgo.com/html/?q=${encoded}&kl=wt-wt`, parse: parseDuckDuckGoResults },
    { name: 'DuckDuckGo', url: `https://duckduckgo.com/html/?q=${encoded}&kl=wt-wt`, parse: parseDuckDuckGoResults },
    { name: 'Bing', url: `https://www.bing.com/search?q=${encoded}`, parse: parseBingResults },
  );
  const failures: string[] = [];

  for (const attempt of attempts) {
    try {
      const body = await fetchSearchPage(attempt.url, attempt.headers);
      const results = attempt.parse(body, maxResults);
      if (results.length > 0) return results;
      failures.push(`${attempt.name}: no parseable results`);
    } catch (err) {
      const message = String((err as Error).message ?? err) || 'unknown error';
      failures.push(`${attempt.name}: ${message}`);
    }
  }

  throw new Error(failures.join('; '));
}

export async function testBraveSearchApi(query = 'BurstCode'): Promise<SearchResult[]> {
  const braveKey = getBraveApiKey();
  if (!braveKey) {
    throw new Error('burstcode.web.braveApiKey is not configured');
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
  let response: FetchResult;
  try {
    response = await fetchUrl(url, MAX_REDIRECTS, {
      'Accept': 'application/json',
      'X-Subscription-Token': braveKey,
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err).trim();
    throw new Error(`network/proxy request failed${msg ? `: ${msg}` : ''}`);
  }

  const body = response.body.toString('utf-8');
  if (response.statusCode >= 400) {
    const reason = describeBraveStatus(response.statusCode);
    const detail = summarizeResponseBody(body);
    throw new Error(`HTTP ${response.statusCode} (${reason})${detail ? ` — ${detail}` : ''}`);
  }

  let results: SearchResult[];
  try {
    results = parseBraveResults(body, 3);
  } catch (err) {
    const msg = String((err as Error).message ?? err).trim();
    const detail = summarizeResponseBody(body);
    throw new Error(`Brave Search returned invalid JSON${msg ? `: ${msg}` : ''}${detail ? ` — ${detail}` : ''}`);
  }

  if (results.length === 0) {
    const detail = summarizeResponseBody(body);
    throw new Error(`Brave Search returned no parseable results${detail ? ` — ${detail}` : ''}`);
  }
  return results;
}

export const webSearchTool: Tool = {
  name: 'web_search',
  parallelSafe: true,
  noTimeout: true,
  schema: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web via Brave Search (when burstcode.web.braveApiKey is configured), DuckDuckGo, and Bing, then return a list of result titles, URLs, and snippets. ' +
        'Use this when you need to find documentation, error solutions, API references, or any information not available in the workspace. ' +
        'After getting results, call read_webpage with a specific URL to read the full content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific — include library name, version, error message, etc.'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default 8, max 20).'
          }
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

    let results: SearchResult[];
    try {
      results = await duckduckgoSearch(query, maxResults);
    } catch (err) {
      return {
        content: `web_search: search failed — ${String((err as Error).message ?? err)}`,
        isError: true
      };
    }

    if (ctx.cancellation.isCancellationRequested) {
      return { content: 'web_search: cancelled', isError: true };
    }

    if (results.length === 0) {
      return {
        content: `web_search: no results found for "${query}". Try rephrasing or using read_webpage with a known URL.`,
        meta: { query, count: 0 }
      };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   URL: ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`
    );

    return {
      content: `# Web search: "${query}" (${results.length} results)\n\n${lines.join('\n\n')}`,
      meta: { query, count: results.length }
    };
  }
};

// ---------------------------------------------------------------------------
// Tool definition — read_webpage
// ---------------------------------------------------------------------------

export const readWebpageTool: Tool = {
  name: 'read_webpage',
  parallelSafe: true,
  noTimeout: true,
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
      result = await fetchUrl(url);
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
