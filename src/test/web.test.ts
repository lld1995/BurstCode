/**
 * Unit tests for src/agent/tools/web.ts
 * Run via: npm test
 *
 * vscode is injected via register-vscode-mock.js (--require preload).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
// These are imported after vscode mock is in cache (preload script runs first)
import { fetchUrl, htmlToText, webSearchTool } from '../agent/tools/web';

const vscodeMock = require('./vscode-mock') as {
  __setConfig: (section: string, values: Record<string, unknown>) => void;
  __clearAll: () => void;
};

// ---------------------------------------------------------------------------
// fetchUrl() and pure HTML parsing
// ---------------------------------------------------------------------------
describe('fetchUrl and htmlToText', () => {
  beforeEach(() => {
    vscodeMock.__clearAll();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
  });

  test('rejects invalid URLs', async () => {
    await assert.rejects(() => fetchUrl('not-a-url'), /Invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// htmlToText() — pure function, no network
// ---------------------------------------------------------------------------
describe('htmlToText', () => {
  test('strips script and style blocks', () => {
    const html = '<html><head><style>body{}</style></head><body><script>alert(1)</script><p>Hello</p></body></html>';
    const { text } = htmlToText(html, 'https://example.com');
    assert.ok(!text.includes('alert'), 'script content should be removed');
    assert.ok(!text.includes('body{}'), 'style content should be removed');
    assert.ok(text.includes('Hello'));
  });

  test('extracts hyperlinks with resolved relative URLs', () => {
    const html = '<p><a href="/about">About</a> <a href="https://other.com">Other</a></p>';
    const { links } = htmlToText(html, 'https://example.com');
    const urls = links.map(l => l.url);
    assert.ok(urls.some(u => u === 'https://example.com/about'), 'relative link resolved');
    assert.ok(urls.some(u => u === 'https://other.com/'), 'absolute link included');
  });

  test('collapses whitespace', () => {
    const html = '<p>  Hello   World  </p>';
    const { text } = htmlToText(html, 'https://example.com');
    assert.ok(!text.includes('   '), 'multiple spaces should be collapsed');
  });

  test('returns empty links for html with no anchors', () => {
    const html = '<p>No links here</p>';
    const { links } = htmlToText(html, 'https://example.com');
    assert.equal(links.length, 0);
  });
});


describe('gateway web search', () => {
  for (const inherit of [true, false]) {
    test(`POST search with ${inherit ? 'inherited' : 'dedicated'} configuration`, async () => {
      vscodeMock.__clearAll();
      let received: unknown;
      let authorization: string | undefined;
      let requestPath: string | undefined;
      let method: string | undefined;
      const server = http.createServer((req, res) => {
        authorization = req.headers.authorization;
        requestPath = req.url;
        method = req.method;
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          received = JSON.parse(body);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com/', snippet: 'Snippet' }] }));
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
      vscodeMock.__setConfig('burstcode.llm', { 'chat.baseURL': inherit ? base : 'http://invalid.test/v1', 'chat.apiKey': 'chat-key' });
      vscodeMock.__setConfig('burstcode.web', { inheritChatConfig: inherit, searchBaseURL: inherit ? 'http://invalid.test/v1' : base, searchApiKey: 'dedicated-key' });
      try {
        const result = await webSearchTool.execute({ query: 'test query', maxResults: 3 }, {
          cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
          emitProgress() {}
        });
        assert.equal(result.isError, undefined, result.content);
        assert.equal(method, 'POST');
        assert.equal(requestPath, '/v1/web_search');
        assert.equal(authorization, `Bearer ${inherit ? 'chat-key' : 'dedicated-key'}`);
        assert.deepEqual(received, { query: 'test query', count: 3 });
        assert.match(result.content, /Snippet/);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        vscodeMock.__clearAll();
      }
    });
  }

  test('requires a dedicated API key when inheritance is disabled', async () => {
    vscodeMock.__clearAll();
    vscodeMock.__setConfig('burstcode.web', {
      inheritChatConfig: false,
      searchBaseURL: 'http://127.0.0.1:1/v1',
      searchApiKey: ''
    });
    const result = await webSearchTool.execute({ query: 'missing key' }, {
      cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
      emitProgress() {}
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /dedicated web-search API key/i);
  });
});
