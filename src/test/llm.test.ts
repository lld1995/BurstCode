import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatMessage,
  getCachedFetchedModels,
  isImageContentRejectedError,
  modelRecordSupportsVision,
  prepareMessagesForModel
} from '../llm/OpenAIClient';

describe('prepareMessagesForModel vision compatibility', () => {
  const history: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '请描述这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    },
    { role: 'assistant', content: '这是一张测试图片。' },
    { role: 'user', content: '继续回答，但现在使用文本模型。' }
  ];

  test('removes historical image_url parts for a text-only model', () => {
    const prepared = prepareMessagesForModel(history, 'qwen-coder', false);
    const first = prepared[0] as Extract<ChatMessage, { role: 'user' }>;

    assert.ok(Array.isArray(first.content));
    assert.deepEqual(first.content, [{ type: 'text', text: '请描述这张图' }]);
    assert.equal(JSON.stringify(prepared).includes('data:image/png'), false);
    assert.equal(JSON.stringify(history).includes('data:image/png'), true, 'persistent history must remain unchanged');
  });

  test('preserves historical images for a vision model', () => {
    const prepared = prepareMessagesForModel(history, 'qwen-vl', true);
    assert.equal(JSON.stringify(prepared).includes('data:image/png'), true);
  });

  test('fails closed when vision capability is unknown', () => {
    const prepared = prepareMessagesForModel(history, 'deepseek-v4-flash');
    assert.equal(JSON.stringify(prepared).includes('image_url'), false);
    assert.equal(JSON.stringify(prepared).includes('data:image/png'), false);
  });

  test('replaces an image-only turn with a textual placeholder', () => {
    const imageOnly: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }]
    }];
    const prepared = prepareMessagesForModel(imageOnly, 'text-model', false);
    assert.equal(prepared[0].content, '[Image omitted because the current model does not support vision.]');
  });

  test('removes image_url blocks even when stale history stored them on a non-user role', () => {
    const malformedHistory = [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'historical answer' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } }
      ]
    }] as unknown as ChatMessage[];
    const prepared = prepareMessagesForModel(malformedHistory, 'deepseek-v4-flash', false);
    assert.equal(JSON.stringify(prepared).includes('image_url'), false);
    assert.deepEqual(prepared[0].content, [{ type: 'text', text: 'historical answer' }]);
  });
});

describe('image_url provider rejection detection', () => {
  test('matches the Provider z1 text-only deserialization error', () => {
    const error = new Error('400 Provider z1: Failed to deserialize messages[108]: unknown variant `image_url`, expected `text`');
    assert.equal(isImageContentRejectedError(error), true);
  });

  test('does not swallow unrelated 400 errors', () => {
    assert.equal(isImageContentRejectedError(new Error('HTTP 400 invalid tool schema')), false);
  });
});

describe('modelRecordSupportsVision', () => {
  test('does not treat string false capability values as truthy', () => {
    assert.equal(modelRecordSupportsVision({ capabilities: { vision: 'false', images: 'false' } }), false);
  });

  test('accepts only explicit boolean flags or an image input modality', () => {
    assert.equal(modelRecordSupportsVision({ capabilities: { vision: true } }), true);
    assert.equal(modelRecordSupportsVision({ capabilities: { images: true } }), true);
    assert.equal(modelRecordSupportsVision({ capabilities: { input_modalities: ['text', 'IMAGE'] } }), true);
    assert.equal(modelRecordSupportsVision({ capabilities: { input_modalities: 'text,image' } }), false);
  });
});

describe('getCachedFetchedModels', () => {
  test('normalises stale string false values from persistent globalState', () => {
    const memento = {
      get: () => ({
        'https://provider-z1.example/v1': {
          fetchedAt: 1,
          models: [{ id: 'deepseek-v4-flash', supportsVision: 'false' }]
        }
      })
    } as unknown as Parameters<typeof getCachedFetchedModels>[0];

    const cached = getCachedFetchedModels(memento, 'https://provider-z1.example/v1');
    assert.deepEqual(cached?.models, [{ id: 'deepseek-v4-flash', supportsVision: false }]);
  });
});
