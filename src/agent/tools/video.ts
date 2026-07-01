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
export function buildVideoTool(logger: Logger, getDefaultFrameImages?: () => VideoFirstFrameAttachment[] | undefined): Tool {
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
          'workspace. Use when the user asks to create / generate a video, animation, or motion clip. ' +
          'If the current chat turn includes pasted/attached images and the user asks for first-frame, last-frame, ' +
          'or image-to-video generation, call this tool even without imageUrl/firstFrameImage/lastFrameImage; ' +
          'BurstCode will automatically use the first pasted image as the first frame and, when multiple images ' +
          'are attached, the last pasted image as the last frame.',
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
                'When provided, the model generates an image-to-video (i2v) result; otherwise text-to-video (t2v). ' +
                'Leave empty when the user pasted/attached an image in the current chat turn; the tool will use it automatically.'
            },
            firstFrameImage: {
              type: 'string',
              description:
                'Alias for imageUrl: optional first-frame image URL, data URL, or workspace-relative image path. ' +
                'Leave empty to use the first pasted/attached image from the current chat turn.'
            },
            lastFrameImage: {
              type: 'string',
              description:
                'Optional last-frame/end-frame image URL, data URL, or workspace-relative image path. ' +
                'Leave empty to use the last pasted/attached image from the current chat turn when multiple images are attached.'
            },
            lastFrame: {
              type: 'string',
              description:
                'Alias for lastFrameImage: optional last-frame/end-frame image URL, data URL, or workspace-relative image path.'
            },
            endImage: {
              type: 'string',
              description:
                'Alias for lastFrameImage: optional end-frame image URL, data URL, or workspace-relative image path.'
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

      const defaultFrames = getDefaultFrameImages?.() ?? [];
      const firstFrameFallback = defaultFrames[0];
      const lastFrameFallback = defaultFrames.length > 1 ? defaultFrames[defaultFrames.length - 1] : undefined;

      const resolveFrameImage = async (
        rawValue: unknown,
        fallback: VideoFirstFrameAttachment | undefined,
        role: 'first' | 'last'
      ): Promise<{ imageUrl?: string; source?: 'argument' | 'pasted-chat-image'; error?: string }> => {
        const rawImageUrl = String(rawValue ?? '').trim();
        const label = role === 'first' ? 'first-frame' : 'last-frame';
        if (rawImageUrl) {
          if (
            fallback?.dataUrl &&
            /^data:image\//i.test(fallback.dataUrl) &&
            fallback.name &&
            rawImageUrl.replace(/^.*[\\/]/, '').toLowerCase() === fallback.name.toLowerCase()
          ) {
            ctx.emitProgress(`Using pasted chat image (${fallback.name}) as the ${role} frame.`);
            return { imageUrl: fallback.dataUrl, source: 'pasted-chat-image' };
          }

          if (/^(https?:|data:image\/)/i.test(rawImageUrl)) {
            return { imageUrl: rawImageUrl, source: 'argument' };
          }

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
            ctx.emitProgress(`Using ${label} image file ${rawImageUrl} (${(buf.length / 1024).toFixed(1)} KB).`);
            return { imageUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}`, source: 'argument' };
          } catch (err) {
            return {
              error:
                `generate_video: failed to read ${label} image "${rawImageUrl}" as a workspace file — ${String((err as Error)?.message ?? err)}\n` +
                'If this is a pasted chat attachment, leave the frame argument empty or use the attachment filename exactly as shown.'
            };
          }
        }

        if (fallback?.dataUrl && /^data:image\//i.test(fallback.dataUrl)) {
          ctx.emitProgress(
            `Using pasted chat image${fallback.name ? ` (${fallback.name})` : ''} as the ${role} frame.`
          );
          return { imageUrl: fallback.dataUrl, source: 'pasted-chat-image' };
        }

        return {};
      };

      // Resolve optional first/last frame image references (URL/data URL, local file, or pasted-chat image name).
      const firstFrame = await resolveFrameImage(args.imageUrl ?? args.firstFrameImage, firstFrameFallback, 'first');
      if (firstFrame.error) return { content: firstFrame.error, isError: true };
      const lastFrame = await resolveFrameImage(args.lastFrameImage ?? args.lastFrame ?? args.endImage, lastFrameFallback, 'last');
      if (lastFrame.error) return { content: lastFrame.error, isError: true };

      const imageUrl = firstFrame.imageUrl;
      const lastFrameImageUrl = lastFrame.imageUrl;
      const imageSource = firstFrame.source;
      const lastFrameImageSource = lastFrame.source;

      ctx.emitProgress(`Generating video with ${cfg.model} …`);

      const ac = new AbortController();
      const sub = ctx.cancellation.onCancellationRequested(() => ac.abort());
      let result;
      try {
        result = await generateVideo(cfg, prompt, {
          imageUrl,
          lastFrameImageUrl,
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
          (lastFrameImageSource === 'pasted-chat-image' ? '\nLast frame: pasted chat image.' : lastFrameImageSource === 'argument' ? '\nLast frame: image argument.' : '') +
          `\nSource URL: ${result.videoUrl}`,
        meta: { path: uri.toString(), bytes: result.data.length, mimeType: result.mimeType, firstFrameImageSource: imageSource, lastFrameImageSource }
      };
    }
  };
}
