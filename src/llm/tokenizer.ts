import { encode } from 'gpt-tokenizer';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Rough fallback: 4 chars per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Extract pixel dimensions (width, height) from the binary header of a
 * common image format (PNG / JPEG / GIF / WebP) embedded in a data URL.
 * Returns null when the format is unrecognized or the header is too short.
 */
function extractImageDimensions(dataUrl: string): { width: number; height: number } | null {
  const match = /^data:(image\/[a-z+]+);base64,/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  // Decode enough bytes to cover headers of all supported formats.
  // JPEG SOF markers can sit after several KB of EXIF, so decode generously.
  const b64 = dataUrl.slice(match[0].length);
  const bin = Buffer.from(b64.slice(0, 8192), 'base64');

  if (mime === 'image/png') {
    // IHDR chunk: width (4B BE) at offset 16, height (4B BE) at offset 20
    if (bin.length < 24) return null;
    return { width: bin.readUInt32BE(16), height: bin.readUInt32BE(20) };
  }
  if (mime === 'image/gif') {
    // Logical screen descriptor: width (2B LE) at offset 6, height (2B LE) at offset 8
    if (bin.length < 10) return null;
    return { width: bin.readUInt16LE(6), height: bin.readUInt16LE(8) };
  }
  if (mime === 'image/jpeg') {
    // Scan markers for SOF0–SOF15 (excluding DHT/JPG/DAC) to find dimensions.
    let i = 2; // skip SOI (FF D8)
    while (i < bin.length - 9) {
      if (bin[i] !== 0xff) { i++; continue; }
      const marker = bin[i + 1];
      i += 2;
      if (marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // length(2) + precision(1) + height(2 BE) + width(2 BE)
        if (i + 5 < bin.length) {
          return { height: bin.readUInt16BE(i + 3), width: bin.readUInt16BE(i + 5) };
        }
        return null;
      }
      // Skip variable-length segment
      if (i + 1 < bin.length) {
        i += bin.readUInt16BE(i);
      } else break;
    }
    return null;
  }
  if (mime === 'image/webp') {
    // RIFF....WEBP, then VP8/VP8L/VP8X chunk
    if (bin.length < 30) return null;
    const fourcc = bin.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ') {
      return { width: bin.readUInt16LE(26), height: bin.readUInt16LE(28) };
    }
    if (fourcc === 'VP8L') {
      const bits = bin.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      return {
        width: (bin.readUInt32LE(24) & 0xffffff) + 1,
        height: (bin.readUInt32LE(27) & 0xffffff) + 1,
      };
    }
    return null;
  }
  return null;
}

/**
 * Estimate the token cost of an image using the OpenAI vision tile formula:
 *   1. Scale so the longest side ≤ 2048 px.
 *   2. Scale so the shortest side ≤ 768 px.
 *   3. Divide into 512×512 tiles → tokens = tiles × 170 + 85.
 *
 * If dimensions cannot be determined, falls back to a conservative flat
 * estimate (765 tokens ≈ one 768×768 image).
 *
 * @see https://platform.openai.com/docs/guides/vision
 */
function estimateImageTokens(dataUrl: string): number {
  const dims = extractImageDimensions(dataUrl);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return 765; // conservative default: 768×768 → 2×2 tiles × 170 + 85
  }
  let w = dims.width;
  let h = dims.height;
  // Step 1: cap longest side at 2048
  const longest = Math.max(w, h);
  if (longest > 2048) {
    const scale = 2048 / longest;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  // Step 2: cap shortest side at 768
  const shortest = Math.min(w, h);
  if (shortest > 768) {
    const scale = 768 / shortest;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  // Step 3: count 512×512 tiles
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return tiles * 170 + 85;
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      // Handle multimodal content: text parts are tokenized normally, while
      // image_url parts must NOT be tokenized as base64 text — that would
      // inflate the estimate by 100-500×. Instead we use the OpenAI vision
      // tile formula based on pixel dimensions.
      for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as { type?: string; text?: string; image_url?: { url?: string } };
        if (p.type === 'text' && typeof p.text === 'string') {
          total += estimateTokens(p.text);
        } else if (p.type === 'image_url' && p.image_url?.url) {
          total += estimateImageTokens(p.image_url.url);
        } else {
          total += estimateTokens(JSON.stringify(p));
        }
      }
    }
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total + 2;
}
