// Standalone regression tests for src/agent/tools/web.ts proxy handling.
// Usage:
//   npm run compile-tests
//   node scripts/test-web-proxy.js
//   BRAVE_API_KEY=... PROXY_URL=http://127.0.0.1:7888 node scripts/test-web-proxy.js --live-brave

const assert = require('assert');
const http = require('http');
const net = require('net');
const Module = require('module');

let cachedProxyUrl = process.env.PROXY_URL || '';
let cachedBraveApiKey = process.env.BRAVE_API_KEY || '';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        getConfiguration(section) {
          return {
            get(key) {
              if (section === 'burstcode.web' && key === 'proxyUrl') return cachedProxyUrl;
              if (section === 'burstcode.web' && key === 'braveApiKey') return cachedBraveApiKey;
              if (section === 'http' && key === 'proxy') return '';
              return undefined;
            },
          };
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { __webTest, webSearchTool } = require('../out/agent/tools/web.js');

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    server.close((err) => {
      clearTimeout(timer);
      err ? reject(err) : resolve();
    });
  });
}

function startTargetServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ ok: true, url: req.url, host: req.headers.host }));
  });
  return listen(server).then((port) => ({ server, port }));
}

function startConnectProxy(options = {}) {
  const connectRequests = [];
  const upgradedSockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(501);
    res.end('plain proxy requests are not used by this client');
  });

  server.on('connect', (req, clientSocket, head) => {
    upgradedSockets.add(clientSocket);
    clientSocket.on('close', () => upgradedSockets.delete(clientSocket));
    connectRequests.push({ url: req.url, headers: req.headers });
    if (options.inlineResponse) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: unit-test\r\n\r\n');
      clientSocket.write(options.inlineResponse);
      return;
    }

    const [host, portText] = String(req.url).split(':');
    const upstream = net.connect(Number(portText), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: unit-test\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upgradedSockets.add(upstream);
    upstream.on('close', () => upgradedSockets.delete(upstream));
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  return listen(server).then((port) => ({ server, port, connectRequests, upgradedSockets }));
}

async function localProxyFetchTest() {
  const target = await startTargetServer();
  const proxy = await startConnectProxy();
  try {
    const result = await __webTest.fetchUrlWithProxy(
      `http://127.0.0.1:${target.port}/hello?x=1`,
      0,
      { Accept: 'application/json' },
      new URL(`http://127.0.0.1:${proxy.port}`)
    );
    const body = JSON.parse(result.body.toString('utf8'));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.url, '/hello?x=1');
    assert.strictEqual(proxy.connectRequests.length, 1);
    assert.strictEqual(proxy.connectRequests[0].url, `127.0.0.1:${target.port}`);
    for (const socket of proxy.upgradedSockets) socket.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    cachedProxyUrl = `http://127.0.0.1:${proxy.port}`;
    const configuredProxy = __webTest.getProxyUrl();
    assert.strictEqual(configuredProxy.href, cachedProxyUrl + '/');

    console.log('PASS local CONNECT proxy fetch');
    await close(proxy.server);
    await close(target.server);
  } finally {
    for (const socket of proxy.upgradedSockets) socket.destroy();
    for (const socket of target.upgradedSockets ?? []) socket.destroy();
  }
}

async function connectLeftoverBytesTest() {
  const inlineBody = JSON.stringify({ ok: true, mode: 'inline-after-connect' });
  const inlineResponse = [
    'HTTP/1.1 200 OK',
    'content-type: application/json',
    `content-length: ${Buffer.byteLength(inlineBody)}`,
    'connection: close',
    '',
    inlineBody,
    '',
  ].join('\r\n');
  const proxy = await startConnectProxy({ inlineResponse });
  try {
    const result = await __webTest.fetchUrlWithProxy(
      'http://example.test/inline',
      0,
      { Accept: 'application/json' },
      new URL(`http://127.0.0.1:${proxy.port}`)
    );
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(result.body.toString('utf8')), { ok: true, mode: 'inline-after-connect' });
    console.log('PASS CONNECT leftover bytes preserved');
  } finally {
    for (const socket of proxy.upgradedSockets) socket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await close(proxy.server);
  }
}

async function redirectKeepsExplicitProxyTest() {
  const finalTarget = await startTargetServer();
  const redirector = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${finalTarget.port}/final` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  const redirectPort = await listen(redirector);
  const proxy = await startConnectProxy();
  try {
    const result = await __webTest.fetchUrlWithProxy(
      `http://127.0.0.1:${redirectPort}/redirect`,
      2,
      {},
      new URL(`http://127.0.0.1:${proxy.port}`)
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(JSON.parse(result.body.toString('utf8')).url, '/final');
    assert.deepStrictEqual(
      proxy.connectRequests.map((r) => r.url),
      [`127.0.0.1:${redirectPort}`, `127.0.0.1:${finalTarget.port}`]
    );
    console.log('PASS redirects keep explicit proxy');
  } finally {
    await close(proxy.server);
    await close(redirector);
    await close(finalTarget.server);
  }
}

async function liveBraveTest() {
  const apiKey = process.env.BRAVE_API_KEY;
  const proxyUrl = process.env.PROXY_URL || 'http://127.0.0.1:7888';
  assert.ok(apiKey, 'BRAVE_API_KEY is required for --live-brave');

  const braveUrl = __webTest.buildBraveSearchUrl('BurstCode', 3);
  assert.match(braveUrl, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/);
  assert.match(braveUrl, /[?&]q=BurstCode(?:&|$)/);
  assert.match(braveUrl, /[?&]count=3(?:&|$)/);
  assert.match(braveUrl, /[?&]country=US(?:&|$)/);
  assert.match(__webTest.classifyBraveRequestError(new Error('HTTP 422')), /Brave Search request failed/);

  console.log(`Testing Brave through explicit proxy override ${proxyUrl} ...`);
  const directResults = await __webTest.testBraveSearchApiWithOptions('BurstCode', { apiKey, proxyUrl });
  assert.ok(directResults.length > 0, 'expected Brave results');
  console.log(`PASS live Brave explicit proxy: ${directResults[0].title} -> ${directResults[0].url}`);

  cachedBraveApiKey = apiKey;
  cachedProxyUrl = proxyUrl;
  console.log(`Testing Brave through extension-style vscode settings ${proxyUrl} ...`);
  const configuredResults = await __webTest.testBraveSearchApi('BurstCode');
  assert.ok(configuredResults.length > 0, 'expected Brave results via configured settings');
  console.log(`PASS live Brave configured proxy: ${configuredResults[0].title} -> ${configuredResults[0].url}`);

  console.log('Testing web_search tool execute path ...');
  const toolResult = await webSearchTool.execute(
    { query: 'BurstCode', maxResults: 3 },
    { emitProgress() {}, cancellation: { isCancellationRequested: false } }
  );
  assert.strictEqual(toolResult.isError, undefined, toolResult.content);
  assert.match(toolResult.content, /# Web search:/);
  console.log('PASS web_search tool execute path');
}

(async () => {
  await localProxyFetchTest();
  await connectLeftoverBytesTest();
  await redirectKeepsExplicitProxyTest();
  if (process.argv.includes('--live-brave')) await liveBraveTest();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
