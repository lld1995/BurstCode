// Provider rejections around images and non-retryable requests, exercised
// against a local OpenAI-compatible mock server.
// Run: node scripts/test-llm-image-fallback.cjs
const assert = require('node:assert/strict');
const http = require('node:http');
const { loadTs, anything } = require('./testkit.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function mockProvider(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, body });
      respond({ body, res });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const carriesImages = (body) => JSON.stringify(body.messages).includes('"image_url"');
function answer(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.write(chunk({ role: 'assistant', content: text }, null));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}
function refuse(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}
// What a capability-routing gateway answers when a chat carries images but the
// selected model has no image-capable route.
const ROUTE_ERROR = "No enabled route target supports model 'test-model' with multimodal input. Available providers: p";

const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function collect(client, messages) {
  const out = [];
  for await (const chunk of client.streamChat(messages, [], token())) out.push(chunk);
  return out;
}
const HISTORY_WITH_IMAGE = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  { role: 'assistant', content: 'a screenshot' },
  { role: 'user', content: 'continue' }
];

let OpenAIClient, pure;
test('bundle the LLM client', async () => {
  ({ OpenAIClient, ...pure } = await loadTs('src/llm/OpenAIClient.ts', { vscode: anything() }));
});
const makeClient = (baseURL, extra = {}) => new OpenAIClient(
  { baseURL, apiKey: 'test-key', model: 'test-model', temperature: 0, contextWindow: 100000, ...extra }, logger);

test('a chat whose history carries images survives a model that refuses them', async () => {
  const provider = await mockProvider(({ body, res }) => (carriesImages(body) ? refuse(res, 400, ROUTE_ERROR) : answer(res, 'ok')));
  try {
    let remembered = 0;
    const chunks = await collect(makeClient(provider.baseURL, { supportsVision: true, onImagesRejected: () => remembered++ }), HISTORY_WITH_IMAGE);
    assert.equal(chunks.map((c) => c.contentDelta || '').join(''), 'ok');
    assert.equal(chunks.at(-1).finishReason, 'stop');
    assert.equal(provider.requests.length, 2, 'exactly one retry');
    assert.equal(carriesImages(provider.requests[0].body), true);
    assert.equal(carriesImages(provider.requests[1].body), false, 'the retry leaves every image out');
    assert.equal(remembered, 1, 'the host is told the model takes no images');
  } finally { await provider.close(); }
});

test('when the retry fails too, the original rejection is reported and nothing is remembered', async () => {
  let calls = 0;
  const provider = await mockProvider(({ body, res }) => (calls++ === 0 ? refuse(res, 400, ROUTE_ERROR) : refuse(res, 400, 'still bad')));
  try {
    let remembered = 0;
    await assert.rejects(
      collect(makeClient(provider.baseURL, { supportsVision: true, onImagesRejected: () => remembered++ }), HISTORY_WITH_IMAGE),
      (err) => /multimodal input/.test(String(err)) && !/still bad/.test(String(err))
    );
    assert.equal(provider.requests.length, 2);
    assert.equal(remembered, 0);
  } finally { await provider.close(); }
});

test('rate limiting and requests without images are not retried', async () => {
  const limited = await mockProvider(({ res }) => refuse(res, 429, { message: 'slow down' }));
  try {
    await assert.rejects(collect(makeClient(limited.baseURL, { supportsVision: true }), HISTORY_WITH_IMAGE));
    assert.equal(limited.requests.length, 1, 'a 429 is not about the images');
  } finally { await limited.close(); }
  const plain = await mockProvider(({ res }) => refuse(res, 400, { message: 'invalid tool schema' }));
  try {
    await assert.rejects(collect(makeClient(plain.baseURL, { supportsVision: true }), [{ role: 'user', content: 'plain' }]), /invalid tool schema/);
    assert.equal(plain.requests.length, 1, 'nothing to strip, nothing to retry');
  } finally { await plain.close(); }
});

test('images are left out up front once the model is not trusted with them', async () => {
  const provider = await mockProvider(({ res }) => answer(res, 'ok'));
  try {
    const chunks = await collect(makeClient(provider.baseURL, { supportsVision: false }), HISTORY_WITH_IMAGE);
    assert.equal(carriesImages(provider.requests[0].body), false);
    assert.equal(provider.requests.length, 1);
    assert.equal(chunks.map((c) => c.contentDelta || '').join(''), 'ok');
  } finally { await provider.close(); }
});

test('rejection classifiers', () => {
  const { isImageContentRejectedError, shouldRetryWithoutImages, errorStatus, messagesHaveImages } = pure;
  assert.equal(errorStatus({ status: 422 }), 422);
  assert.equal(errorStatus(new Error('Gemini direct chat/completions HTTP 413: too large')), 413);
  assert.equal(errorStatus(new Error('fetch failed')), undefined);
  assert.equal(messagesHaveImages(HISTORY_WITH_IMAGE), true);
  assert.equal(messagesHaveImages([{ role: 'user', content: 'text' }]), false);
  // Recognised wordings.
  for (const text of [
    "400 Provider z1: Failed to deserialize messages[108]: unknown variant `image_url`, expected `text`",
    'HTTP 400: The request is invalid: messages.content.type 参数非法，取值范围 [\'text\']',
    "HTTP 400: messages.content.type must be one of ['text']",
    ROUTE_ERROR,
    'This model does not support image input'
  ]) {
    assert.equal(isImageContentRejectedError(new Error(text)), true, text);
    assert.equal(shouldRetryWithoutImages(new Error(text)), true, text);
  }
  for (const text of ['HTTP 400 invalid tool schema', 'HTTP 400: messages.1.role is invalid']) {
    assert.equal(isImageContentRejectedError(new Error(text)), false, text);
  }
  // With images on the wire any 4xx about the request body is worth one retry...
  assert.equal(shouldRetryWithoutImages({ status: 400 }), true);
  assert.equal(shouldRetryWithoutImages(new Error('Gemini direct chat/completions HTTP 422: x')), true);
  // ...but not statuses that cannot be caused by images.
  for (const status of [401, 403, 404, 408, 429, 500, 502, 503]) {
    assert.equal(shouldRetryWithoutImages({ status }), false, String(status));
  }
  assert.equal(shouldRetryWithoutImages(new Error('socket hang up')), false);
});

// ---- agent loop: a rejected request must not be resumed forever -------------
const applier = {
  onPendingStateChange: () => ({ dispose() {} }),
  setCurrentTurn() {},
  setCurrentSession() {},
  touchedFilesFrom: () => [],
  getPendingState: () => ({})
};
async function runAgent(client, options) {
  const { AgentLoop } = await loadTs('src/agent/AgentLoop.ts', { vscode: anything() });
  const agent = new AgentLoop(client, [], applier, logger, {
    contextWindow: 100000, maxIterations: 3, systemPrompt: 'sys', ...options
  });
  const events = [];
  for await (const event of agent.run([{ role: 'user', content: 'hi' }], token(), [])) events.push(event.type);
  return events;
}

test('a request the provider rejects ends the run at once instead of resuming without limit', async () => {
  const provider = await mockProvider(({ res }) => refuse(res, 400, { message: 'invalid parameter', type: 'invalid_request_error' }));
  try {
    const events = await runAgent(makeClient(provider.baseURL), { autoResumeOnStreamError: true, maxAutoResumes: 0 });
    assert.equal(provider.requests.length, 1, 'the same bytes are not sent again');
    assert.equal(events.filter((type) => type === 'auto-resume').length, 0);
    assert.equal(events.at(-1), 'error');
  } finally { await provider.close(); }
});

test('a transient outage is still resumed', async () => {
  const provider = await mockProvider(({ res }) => refuse(res, 503, { message: 'overloaded' }));
  try {
    const events = await runAgent(makeClient(provider.baseURL), { autoResumeOnStreamError: true, maxAutoResumes: 1 });
    assert.equal(provider.requests.length, 2);
    assert.equal(events.filter((type) => type === 'auto-resume').length, 1);
    assert.equal(events.at(-1), 'error');
  } finally { await provider.close(); }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS: ${name}`); } catch (err) { failed++; console.error(`FAIL: ${name}\n${(err && err.stack) || err}`); }
  }
  if (failed) process.exitCode = 1;
})()
