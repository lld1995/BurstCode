// The orphan-prune pass must decide exactly what the 0.1.161 pass decided, but
// without re-serializing the whole transcript per candidate.
// Run: node scripts/test-compressor-prune.cjs
const assert = require('node:assert/strict');
const { loadTs, timed } = require('./testkit.cjs');

let pruneOrphanedToolResults, PRUNABLE_TOOLS, extractPathsFromToolResult;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// The pass as it was in 0.1.161, kept as the oracle: for every candidate it
// serialized everything downstream and searched it one path at a time.
function legacyPrune(messages, keepLastN, graceRecentToolResults = 0) {
  const MIN_PRUNE_CHARS = 300;
  let protectedFrom = messages.length;
  let exchangeCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && ++exchangeCount >= keepLastN) { protectedFrom = i; break; }
  }
  const callIdToName = new Map();
  for (const m of messages) for (const c of m.tool_calls ?? []) callIdToName.set(c.id, c.function.name);
  let graceFrom = messages.length;
  if (graceRecentToolResults > 0) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0 && seen < graceRecentToolResults; i--) {
      const m = messages[i];
      if (m.role !== 'tool' || !PRUNABLE_TOOLS.has(callIdToName.get(m.tool_call_id ?? '') ?? '')) continue;
      seen++;
      graceFrom = i;
    }
  }
  const text = (content) => (typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content));
  const downstream = (from) => {
    const parts = [];
    for (let i = from; i < messages.length; i++) {
      parts.push(text(messages[i].content));
      for (const c of messages[i].tool_calls ?? []) parts.push(c.function.arguments ?? '');
    }
    return parts.join('\n').replace(/\\\\/g, '/').replace(/\\/g, '/');
  };
  let pruned = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || i >= protectedFrom || i >= graceFrom) continue;
    const toolName = callIdToName.get(m.tool_call_id ?? '') ?? '';
    if (!PRUNABLE_TOOLS.has(toolName)) continue;
    const content = text(m.content);
    if (content.length <= MIN_PRUNE_CHARS || content.startsWith('[pruned:')) continue;
    const paths = extractPathsFromToolResult(toolName, content);
    if (paths.size === 0) continue;
    const tail = downstream(i + 1);
    if ([...paths].some((p) => tail.includes(p.replace(/\\/g, '/')))) continue;
    const primary = [...paths][0];
    messages[i] = { ...m, content: `[pruned: ${toolName} ${primary}${paths.size > 1 ? ` (+${paths.size - 1} more)` : ''} — content removed, no longer needed]` };
    pruned++;
  }
  return pruned;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const PATHS = [
  'src/app.ts', 'src/lib/util.ts', 'e:\\project\\src\\deep\\file.ts', 'docs/readme.md',
  'src/a/b/c/d/e.ts', 'package.json', 'E:\\project\\src\\app.ts'
];
const PRUNABLE = ['read_file', 'collect_context', 'grep_search', 'workspace_outline', 'list_dir', 'document_symbols'];
const OTHER = ['propose_edit', 'run_shell', 'ask_user', 'web_search'];
function result(tool, path, size) {
  if (tool === 'read_file') return `# ${path} (lines 1-40 of 400)\n` + 'x'.repeat(size);
  if (tool === 'grep_search') return `${path}:12: const a = 1;\n` + 'y'.repeat(size);
  if (tool === 'collect_context') return `===== read_file ${path} =====\n` + 'z'.repeat(size);
  return `${path}\n` + 'w'.repeat(size);
}
function transcript(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const messages = [{ role: 'system', content: 'sys' }];
  let calls = 0;
  const count = 2 + Math.floor(rand() * 40);
  for (let i = 0; i < count; i++) {
    const kind = rand();
    const path = pick(PATHS);
    if (kind < 0.25) {
      messages.push({ role: 'user', content: rand() < 0.5 ? `please look at ${path}` : 'continue' });
    } else if (kind < 0.6) {
      const tool = rand() < 0.8 ? pick(PRUNABLE) : pick(OTHER);
      const args = JSON.stringify(tool === 'propose_edit' ? { path, oldText: 'a' } : { path });
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${++calls}`, type: 'function', function: { name: tool, arguments: args } }] });
      messages.push({ role: 'tool', tool_call_id: `call_${calls}`, content: result(tool, path, 150 + Math.floor(rand() * 900)) });
    } else {
      messages.push({ role: 'assistant', content: rand() < 0.4 ? `I edited ${path} (or ${pick(PATHS)})` : 'done' });
    }
  }
  return messages;
}

test('random transcripts are pruned exactly like before', async () => {
  let compared = 0;
  let prunedTotal = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const rand = rng(seed);
    const messages = transcript(rand);
    const keepLastN = 1 + Math.floor(rand() * 3);
    const grace = [0, 2, 6][Math.floor(rand() * 3)];
    const expectedMessages = structuredClone(messages);
    const expected = legacyPrune(expectedMessages, keepLastN, grace);
    const actualMessages = structuredClone(messages);
    const { value: actual } = await timed(() => pruneOrphanedToolResults(actualMessages, keepLastN, grace));
    assert.equal(actual, expected, `seed ${seed}: pruned count`);
    assert.deepEqual(actualMessages, expectedMessages, `seed ${seed}: resulting transcript`);
    // A second pass over the same array has nothing left to do.
    assert.equal(pruneOrphanedToolResults(actualMessages, keepLastN, grace), 0, `seed ${seed}: second pass`);
    compared++;
    prunedTotal += actual;
  }
  assert.ok(prunedTotal > 100, `the corpus must actually exercise pruning (pruned ${prunedTotal})`);
  return `${compared} transcripts, ${prunedTotal} results pruned`;
});

test('a result is kept while any of its paths is still mentioned later', () => {
  const read = (path, id) => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: `# ${path} (lines 1-40 of 400)\n` + 'x'.repeat(500) }
  ];
  const messages = [
    { role: 'system', content: 'sys' },
    ...read('src/a.ts', 'c1'),
    ...read('src\\b.ts', 'c2'),
    ...read('src/c.ts', 'c3'),
    // Mentioned in a prompt, in a tool argument (JSON-escaped Windows path) and not at all.
    { role: 'user', content: 'now edit src/a.ts' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c4', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify({ path: 'E:\\project\\src\\b.ts' }) } }] },
    { role: 'tool', tool_call_id: 'c4', content: 'ok' },
    { role: 'user', content: 'thanks' }
  ];
  assert.equal(pruneOrphanedToolResults(messages, 1, 0), 1);
  assert.match(messages[2].content, /src\/a\.ts \(lines/);
  assert.match(messages[4].content, /src\\b\.ts \(lines/);
  assert.match(messages[6].content, /^\[pruned: read_file src\/c\.ts/);
});

test('a long session is pruned in one pass instead of freezing the host', async () => {
  const build = (count) => {
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < count; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: `# src/gen/file${i}.ts (lines 1-100 of 4000)\n` + 'x'.repeat(4000) });
    }
    messages.push({ role: 'user', content: 'go on' });
    return messages;
  };
  const old = await timed(() => legacyPrune(build(300), 1, 6));
  const fresh = await timed(() => pruneOrphanedToolResults(build(3000), 1, 6));
  assert.equal(fresh.value, 3000 - 6);
  const again = await timed(() => pruneOrphanedToolResults(build(3000), 1, 6));
  assert.equal(again.value, fresh.value, 'repeatable');
  const megabytes = JSON.stringify(build(3000)).length / 1e6;
  assert.ok(fresh.ms < 3000, `pruning ${megabytes.toFixed(1)} MB took ${fresh.ms.toFixed(0)} ms`);
  return `300 results: ${old.ms.toFixed(0)} ms before vs 3000 results (${megabytes.toFixed(1)} MB): ${fresh.ms.toFixed(0)} ms / ${again.ms.toFixed(0)} ms now`;
});

test('token counts are cached per message', async () => {
  const tokenizer = await loadTs('src/llm/tokenizer.ts');
  const { estimateMessagesTokens, estimateTokens } = tokenizer;
  const plain = { role: 'user', content: 'hello world, this is a sentence' };
  const withCalls = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] };
  const messages = [plain, withCalls, { role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }] }];
  // The 1x1 PNG is one vision tile: 170 + 85 tokens.
  const uncached = 2 + 4 + estimateTokens(plain.content) + 4 + estimateTokens(JSON.stringify(withCalls.tool_calls)) + 4 + estimateTokens('see this') + 255;
  const first = estimateMessagesTokens(messages);
  assert.equal(first, uncached);
  const cached = estimateMessagesTokens(messages);
  assert.equal(cached, first);
  // A rewritten message is a new object and is counted again.
  const rewritten = [plain, { ...withCalls, content: 'added text' }, messages[2]];
  assert.equal(estimateMessagesTokens(rewritten), first + estimateTokens('added text'));
});

(async () => {
  ({ pruneOrphanedToolResults, PRUNABLE_TOOLS, extractPathsFromToolResult } = await loadTs('src/context/Compressor.ts'));
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      const detail = await fn();
      console.log(`PASS: ${name}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      failed++;
      console.error(`FAIL: ${name}\n${(err && err.stack) || err}`);
    }
  }
  if (failed) process.exitCode = 1;
})();
