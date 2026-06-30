import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { generateVideo, VideoConfig } from '../llm/OpenAIClient';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('generateVideo OpenAI-compatible flow', () => {
  test('POSTs /videos, polls /videos/{id}, then downloads /content with auth', async () => {
    const seen: Array<{ method?: string; url?: string; auth?: string; body?: unknown }> = [];
    const videoBytes = Buffer.from('fake-mp4-bytes');

    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        const raw = await readBody(req);
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'vid_test', object: 'video', status: 'queued' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/videos/vid_test') {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'vid_test', object: 'video', status: 'completed' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/videos/vid_test/content') {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(videoBytes);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`${req.method} ${req.url}`);
    });

    const port = await listen(server);
    try {
      const cfg: VideoConfig = {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        model: 'bytedance/doubao-seedance-2.0',
        resolution: '720p',
        duration: '5',
        allowSelfSignedCerts: false
      };

      const result = await generateVideo(cfg, '小鸟在天上飞', {
        pollIntervalMs: 1,
        maxAttempts: 2
      });

      assert.equal(result.mimeType, 'video/mp4');
      assert.deepEqual(result.data, videoBytes);
      assert.match(result.videoUrl, /\/v1\/videos\/vid_test\/content$/);

      assert.deepEqual(
        seen.map((r) => `${r.method} ${r.url}`),
        ['POST /v1/videos', 'GET /v1/videos/vid_test', 'GET /v1/videos/vid_test/content']
      );
      assert.equal(seen[0].auth, 'Bearer test-key');
      assert.equal(seen[1].auth, 'Bearer test-key');
      assert.equal(seen[2].auth, 'Bearer test-key');
      assert.deepEqual(seen[0].body, {
        model: 'bytedance/doubao-seedance-2.0',
        prompt: '小鸟在天上飞',
        seconds: 5,
        size: '1280x720'
      });
    } finally {
      await close(server);
    }
  });

  test('uses a 60 minute default polling budget for live video jobs', async () => {
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/videos');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'vid_timeout', status: 'queued' }));
    });

    const port = await listen(server);
    try {
      const cfg: VideoConfig = {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        model: 'bytedance/doubao-seedance-2.0',
        resolution: '1280x720',
        duration: '5',
        allowSelfSignedCerts: false
      };

      await assert.rejects(
        generateVideo(cfg, '小鸟在天上飞', {
          pollIntervalMs: 60 * 60 * 1000
        }),
        /timed out after 60 minutes/
      );
    } finally {
      await close(server);
    }
  });
});
