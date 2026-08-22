import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TOOL_RESULT_TOKEN_CAP,
  TOOL_RESULT_MAX_CONTEXT_RATIO,
  prepareToolResultForStorage,
  toolResultTokenCap
} from '../context/Compressor';

describe('toolResultTokenCap', () => {
  test('uses 15% of the context window, floored at MIN_TOOL_RESULT_TOKEN_CAP', () => {
    assert.equal(toolResultTokenCap({ contextWindow: 10_000 }), MIN_TOOL_RESULT_TOKEN_CAP);
    assert.equal(
      toolResultTokenCap({ contextWindow: 131_072 }),
      Math.floor(131_072 * TOOL_RESULT_MAX_CONTEXT_RATIO)
    );
  });

  test('tightens to remaining room when the window is already filling', () => {
    const ctx = 131_072;
    const used = 120_000;
    const remaining = ctx - used;
    assert.equal(toolResultTokenCap({ contextWindow: ctx, usedTokens: used }), remaining);
  });

  test('falls back to the floor when remaining room is already gone', () => {
    assert.equal(
      toolResultTokenCap({ contextWindow: 8_000, usedTokens: 9_000 }),
      MIN_TOOL_RESULT_TOKEN_CAP
    );
  });

  test('does not raise remaining room back up to the floor', () => {
    assert.equal(
      toolResultTokenCap({ contextWindow: 8_000, usedTokens: 7_500 }),
      500
    );
  });

  test('does not cap when contextWindow is unset', () => {
    assert.equal(toolResultTokenCap({ contextWindow: 0 }), Number.POSITIVE_INFINITY);
  });
});

describe('prepareToolResultForStorage', () => {
  test('keeps a small result intact', () => {
    const content = '# src/foo.ts (lines 1-20 of 20)\nhello world';
    const prepared = prepareToolResultForStorage('read_file', content, { contextWindow: 131_072 });
    assert.equal(prepared.discarded, false);
    assert.equal(prepared.content, content);
  });

  test('discards an oversized result and tells the model to retry with narrower args', () => {
    const header = '# src/huge.ts (lines 1-8000 of 8000)';
    const content = `${header}\n${'x'.repeat(40_000)}`;
    const prepared = prepareToolResultForStorage('read_file', content, {
      contextWindow: 8_000,
      args: { path: 'src/huge.ts', full: true }
    });
    assert.equal(prepared.discarded, true);
    assert.match(prepared.content, /\[tool-result-discarded\]/);
    assert.match(prepared.content, /Do NOT repeat this call/);
    assert.match(prepared.content, /startLine\/endLine/);
    assert.match(prepared.content, /src\/huge\.ts/);
    assert.equal(prepared.content.includes('x'.repeat(1000)), false, 'original body must not be stored');
  });

  test('collect_context discard hint asks for narrower files/searches', () => {
    const prepared = prepareToolResultForStorage('collect_context', 'y'.repeat(40_000), {
      contextWindow: 8_000
    });
    assert.equal(prepared.discarded, true);
    assert.match(prepared.content, /collect_context/);
    assert.match(prepared.content, /narrower startLine\/endLine/);
  });
});