import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './types';
import { generateVideo, readVideoConfig } from '../../llm/OpenAIClient';
import { Logger } from '../../util/Logger';

export interface VideoFirstFrameAttachment {
  dataUrl: string;
  mimeType: string;
  name?: string;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Turn an arbitrary prompt fragment into a short, filesystem-safe slug. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'video';
}

/**
 * Tool that generates a video from a text prompt (and optional reference image)
 * via an OpenAI-compatible video API (configured under `burstcode.llm.video.*`,
 * falling back to the chat profile). The generated MP4 is written into the
 * workspace so the user can open / commit the result.
 */
export function buildVideoTool(logger: Logger, getDefaultFirstFrameImage?: () => VideoFirstFrameAttachment | undefined): Tool {
  return {
    name: 'generate_video',
    parallelSafe: false,
    noTimeout: true,
    schema: {
      type: 'function',
      function: {
        name: 'generate_video',
        description:
          'Generate a video from a text prompt using the configured video model ' +
          '(burstcode.llm.video, falls back to the chat endpoint). Video models are called ' +
          'through an OpenAI-compatible video API and the generated MP4 is saved into the ' +
          'workspace. Use when the user asks to create / generate a video, animation, or motion clip.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Detailed description of the video to generate (English usually works best).'
            },
            path: {
              type: 'string',
              description:
                'Optional output path (workspace-relative or absolute) for the saved video. ' +
                'When omitted, a file is created under ./generated-videos/ with a slug derived from the prompt.'
            },
            imageUrl: {
              type: 'string',
              description:
                'Optional first-frame/reference image URL (http/https), data URL, or workspace-relative image path. ' +
                'When provided, the model generates an image-to-video (i2v) result; otherwise text-to-video (t2v).'
            },
            firstFrameImage: {
              type: 'string',
              description:
                'Alias for imageUrl: optional first-frame image URL, data URL, or workspace-relative image path.'
            }
          },
          required: ['prompt']
        }
      }
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        return { content: 'generate_video: "prompt" is required.', isError: true };
      }

      const cfg = readVideoConfig();
      if (!cfg.baseURL) {
        return {
          content:
            'generate_video: no video endpoint configured. Set burstcode.llm.video.baseURL/model ' +
            '(or a chat endpoint to inherit) in Settings.',
          isError: true
        };
      }

      // Resolve optional first-frame image reference (URL/data URL, local file, or pasted-chat image name).
      let imageUrl: string | undefined;
      let imageSource: 'argument' | 'pasted-chat-image' | undefined;
      const fallback = getDefaultFirstFrameImage?.();
      const rawImageUrl = String(args.imageUrl ?? args.firstFrameImage ?? '').trim();
      if (rawImageUrl) {
        if (
          fallback?.dataUrl &&
          /^data:image\//i.test(fallback.dataUrl) &&
          fallback.name &&
          rawImageUrl.replace(/^.*[\\/]/, '').toLowerCase() === fallback.name.toLowerCase()
        ) {
          imageUrl = fallback.dataUrl;
          imageSource = 'pasted-chat-image';
          ctx.emitProgress(`Using pasted chat image (${fallback.name}) as the first frame.`);
        } else {
          imageSource = 'argument';
          if (/^(https?:|data:image\/)/i.test(rawImageUrl)) {
            imageUrl = rawImageUrl;
          } else {
            // Treat as a workspace-relative file path → read & encode as data URI.
            const root = workspaceRoot();
            const absPath = path.isAbsolute(rawImageUrl)
              ? rawImageUrl
              : root
              ? path.join(root, rawImageUrl)
              : rawImageUrl;
            try {
              const uri = vscode.Uri.file(
                process.platform === 'win32' ? absPath.replace(/\\/g, '/') : absPath
              );
              const buf = await vscode.workspace.fs.readFile(uri);
              const ext = path.extname(absPath).toLowerCase();
              const mime =
                ext === '.png' ? 'image/png' :
                ext === '.webp' ? 'image/webp' :
                ext === '.gif' ? 'image/gif' :
                'image/jpeg';
              imageUrl = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
              ctx.emitProgress(`Using first-frame image file ${rawImageUrl} (${(buf.length / 1024).toFixed(1)} KB).`);
            } catch (err) {
              return {
                content:
                  `generate_video: failed to read first-frame image "${rawImageUrl}" as a workspace file — ${String((err as Error)?.message ?? err)}\n` +
                  'If this is a pasted chat attachment, leave imageUrl/firstFrameImage empty or use the attachment filename exactly as shown.',
                isError: true
              };
            }
          }
        }
      } else if (fallback?.dataUrl && /^data:image\//i.test(fallback.dataUrl)) {
        imageUrl = fallback.dataUrl;
        imageSource = 'pasted-chat-image';
        ctx.emitProgress(
          `Using pasted chat image${fallback.name ? ` (${fallback.name})` : ''} as the first frame.`
        );
      }

      ctx.emitProgress(`Generating video with ${cfg.model} …`);

      const ac = new AbortController();
      const sub = ctx.cancellation.onCancellationRequested(() => ac.abort());
      let result;
      try {
        result = await generateVideo(cfg, prompt, {
          imageUrl,
          signal: ac.signal,
          onProgress: (msg) => ctx.emitProgress(msg)
        });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg === 'aborted') {
          return { content: 'generate_video: cancelled.', isError: true };
        }
        logger.warn(`generate_video failed: ${msg}`);
        return {
          content:
            `generate_video: request to ${cfg.baseURL} (model "${cfg.model}") failed — ${msg}\n` +
            'Verify burstcode.llm.video.model is a video model and the endpoint supports the task API.',
          isError: true
        };
      } finally {
        sub.dispose();
      }

      if (ctx.cancellation.isCancellationRequested) {
        return { content: 'generate_video: cancelled.', isError: true };
      }

      // Resolve the output path.
      const root = workspaceRoot();
      let outPath: string;
      if (args.path && String(args.path).trim()) {
        const target = String(args.path).trim();
        outPath = path.isAbsolute(target)
          ? target
          : root
          ? path.join(root, target)
          : target;
      } else {
        if (!root) {
          return {
            content: 'generate_video: no workspace folder open — pass an explicit "path".',
            isError: true
          };
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = path.join(root, 'generated-videos', `${slugify(prompt)}-${stamp}.mp4`);
      }

      const uri = vscode.Uri.file(
        process.platform === 'win32' ? outPath.replace(/\\/g, '/') : outPath
      );
      try {
        await vscode.workspace.fs.writeFile(uri, result.data);
      } catch (err) {
        return {
          content: `generate_video: failed to write ${outPath} — ${String((err as Error)?.message ?? err)}`,
          isError: true
        };
      }

      const rel = vscode.workspace.asRelativePath(uri);
      return {
        content:
          `Generated video saved to ${rel} (${(result.data.length / 1024 / 1024).toFixed(1)} MB, ${result.mimeType}).` +
          (imageSource === 'pasted-chat-image' ? '\nFirst frame: pasted chat image.' : imageSource === 'argument' ? '\nFirst frame: image argument.' : '') +
          `\nSource URL: ${result.videoUrl}`,
        meta: { path: uri.toString(), bytes: result.data.length, mimeType: result.mimeType, firstFrameImageSource: imageSource }
      };
    }
  };
}
