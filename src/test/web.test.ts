/**
 * Unit tests for src/agent/tools/web.ts
 * Run via: npm test
 *
 * vscode is injected via register-vscode-mock.js (--require preload).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
// These are imported after vscode mock is in cache (preload script runs first)
import { getProxyUrl, openTunnel, fetchUrl, htmlToText } from '../agent/tools/web';

const vscodeMock = require('./vscode-mock') as {
  __setConfig: (section: string, values: Record<string, unknown>) => void;
  __clearAll: () => void;
};

// ---------------------------------------------------------------------------
// getProxyUrl()
// ---------------------------------------------------------------------------
describe('getProxyUrl', () => {
  beforeEach(() => {
    vscodeMock.__clearAll();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
  });

  test('returns null when no proxy configured', () => {
    const result = getProxyUrl();
    assert.equal(result, null);
  });

  test('burstcode.web.proxyUrl takes highest priority', () => {
    vscodeMock.__setConfig('burstcode.web', { proxyUrl: 'http://127.0.0.1:7890' });
    vscodeMock.__setConfig('http', { proxy: 'http://other:9999' });
    process.env.HTTP_PROXY = 'http://env:8888';
    const result = getProxyUrl();
    assert.ok(result, 'should return a URL');
    assert.equal(result!.hostname, '127.0.0.1');
    assert.equal(result!.port, '7890');
  });

  test('falls back to http.proxy VS Code setting when burstcode setting empty', () => {
    vscodeMock.__setConfig('burstcode.web', { proxyUrl: '' });
    vscodeMock.__setConfig('http', { proxy: 'http://vsproxy:3128' });
    const result = getProxyUrl();
    assert.ok(result);
    assert.equal(result!.hostname, 'vsproxy');
    assert.equal(result!.port, '3128');
  });

  test('falls back to HTTPS_PROXY env var', () => {
    vscodeMock.__setConfig('burstcode.web', { proxyUrl: '' });
    process.env.HTTPS_PROXY = 'http://envproxy:7777';
    const result = getProxyUrl();
    assert.ok(result);
    assert.equal(result!.hostname, 'envproxy');
    assert.equal(result!.port, '7777');
  });

  test('falls back to HTTP_PROXY when HTTPS_PROXY not set', () => {
    process.env.HTTP_PROXY = 'http://httpproxy:4321';
    const result = getProxyUrl();
    assert.ok(result);
    assert.equal(result!.hostname, 'httpproxy');
  });

  test('returns null for invalid proxy URL', () => {
    vscodeMock.__setConfig('burstcode.web', { proxyUrl: 'not-a-url' });
    const result = getProxyUrl();
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// openTunnel() — mock TCP server that acts as an HTTP proxy
// ---------------------------------------------------------------------------
describe('openTunnel', () => {
  test('resolves with a socket when proxy returns 200', async () => {
    const server = net.createServer((client) => {
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes('\r\n\r\n')) {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    try {
      const proxy = new URL(`http://127.0.0.1:${port}`);
      const socket = await openTunnel(proxy, 'example.com', 80, false);
      assert.ok(socket, 'socket should be returned');
      socket.destroy();
    } finally {
      server.close();
    }
  });

  test('rejects when proxy returns non-200', async () => {
    const server = net.createServer((client) => {
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes('\r\n\r\n')) {
          client.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          client.end();
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    try {
      const proxy = new URL(`http://127.0.0.1:${port}`);
      await assert.rejects(
        () => openTunnel(proxy, 'example.com', 80, false),
        /Proxy CONNECT rejected/
      );
    } finally {
      server.close();
    }
  });

  test('sends Proxy-Authorization header when credentials in proxy URL', async () => {
    let receivedHeaders = '';
    const server = net.createServer((client) => {
      client.on('data', (chunk: Buffer) => {
        receivedHeaders += chunk.toString();
        if (receivedHeaders.includes('\r\n\r\n')) {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    try {
      const proxy = new URL(`http://user:pass@127.0.0.1:${port}`);
      const socket = await openTunnel(proxy, 'example.com', 80, false);
      socket.destroy();
      assert.ok(receivedHeaders.includes('Proxy-Authorization: Basic'), 'should send auth header');
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// fetchUrl() proxy path — mock proxy+target server
// ---------------------------------------------------------------------------
describe('fetchUrl via proxy', () => {
  beforeEach(() => {
    vscodeMock.__clearAll();
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
  });

  test('fetches JSON body through proxy (no TLS)', async () => {
    const proxyServer = net.createServer((client) => {
      let buf = Buffer.alloc(0);
      let tunnelled = false;
      client.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!tunnelled) {
          if (buf.toString('ascii').includes('\r\n\r\n')) {
            tunnelled = true;
            buf = Buffer.alloc(0);
            client.write('HTTP/1.1 200 Connection established\r\n\r\n');
          }
        } else {
          if (buf.toString('ascii').includes('\r\n\r\n')) {
          const body = JSON.stringify({ ok: true });
            const resp = Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
            );
            client.write(resp);
            client.end();
          }
        }
      });
    });

    const port = await new Promise<number>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve((proxyServer.address() as net.AddressInfo).port));
    });

    try {
      vscodeMock.__setConfig('burstcode.web', { proxyUrl: `http://127.0.0.1:${port}` });
      const result = await fetchUrl('http://example.com/api/test');
      assert.equal(result.statusCode, 200);
      assert.match(result.mimeType, /application\/json/);
      const json = JSON.parse(result.body.toString());
      assert.equal(json.ok, true);
    } finally {
      proxyServer.close();
    }
  });

  test('rejects when proxy TCP connection is refused', async () => {
    // Find a free port then close the server so nothing listens there
    const tempServer = net.createServer();
    const freePort = await new Promise<number>((resolve) => {
      tempServer.listen(0, '127.0.0.1', () => {
        resolve((tempServer.address() as net.AddressInfo).port);
        tempServer.close();
      });
    });
    vscodeMock.__setConfig('burstcode.web', { proxyUrl: `http://127.0.0.1:${freePort}` });
    await assert.rejects(
      () => fetchUrl('http://example.com/'),
      (err: Error) => err.message.length > 0
    );
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
