import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './types';
import { generateImage, readImageConfig, ImageAction } from '../../llm/OpenAIClient';
import { Logger } from '../../util/Logger';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function extForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}

/** Turn an arbitrary prompt fragment into a short, filesystem-safe slug. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'image';
}

/**
 * Tool that generates an image from a text prompt via the OpenAI-compatible
 * `/v1/images/generations` endpoint (configured under `burstcode.llm.image.*`,
 * falling back to the chat profile). The bytes are written into the workspace
 * so the user can open / commit the result.
 */
export function buildImageTool(logger: Logger, getDefaultImages?: () => Array<{ dataUrl: string; mimeType: string; name?: string }> | undefined): Tool {
  return {
    name: 'generate_image',
    parallelSafe: false,
    noTimeout: true,
    schema: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Generate a new image or edit attached images. Set action to edit when an input image is present and the user asks to modify it; attached chat images are used automatically.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed generation or editing instruction.' },
            action: { type: 'string', enum: ['auto', 'generate', 'edit'], description: 'auto selects edit when images are attached.' },
            imageUrl: { type: 'string', description: 'Optional data URL of an input image to edit.' },
            path: { type: 'string', description: 'Optional output path.' },
            size: { type: 'string', description: 'Optional image size.' }
          },
          required: ['prompt']
        }
      }
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        return { content: 'generate_image: "prompt" is required.', isError: true };
      }
      const size = args.size ? String(args.size).trim() : undefined;
      const action = String(args.action ?? 'auto') as ImageAction;
      const argumentImages = args.imageUrl ? [String(args.imageUrl).trim()] : [];
      const defaultImages = getDefaultImages?.() ?? [];
      const imageDataUrls = [...argumentImages, ...defaultImages.map((image) => image.dataUrl)].filter(Boolean);

      const cfg = readImageConfig();
      if (!cfg.baseURL) {
        return {
          content:
            'generate_image: no image endpoint configured. Set burstcode.llm.image.baseURL/model ' +
            '(or a chat endpoint to inherit) in Settings.',
          isError: true
        };
      }

      ctx.emitProgress(`Generating image with ${cfg.model} …`);

      const ac = new AbortController();
      const sub = ctx.cancellation.onCancellationRequested(() => ac.abort());
      let result;
      try {
        result = await generateImage(cfg, prompt, {
          size,
          action,
          imageDataUrls,
          signal: ac.signal
        });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        logger.warn(`generate_image failed: ${msg}`);
        return {
          content:
            `generate_image: request to ${cfg.baseURL} (model "${cfg.model}") failed — ${msg}\n` +
            'Verify burstcode.llm.image.model is an image model and the endpoint supports /v1/images/generations.',
          isError: true
        };
      } finally {
        sub.dispose();
      }

      if (ctx.cancellation.isCancellationRequested) {
        return { content: 'generate_image: cancelled.', isError: true };
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
            content: 'generate_image: no workspace folder open — pass an explicit "path".',
            isError: true
          };
        }
        const ext = extForMime(result.mimeType);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = path.join(root, 'generated-images', `${slugify(prompt)}-${stamp}.${ext}`);
      }

      const uri = vscode.Uri.file(
        process.platform === 'win32' ? outPath.replace(/\\/g, '/') : outPath
      );
      try {
        await vscode.workspace.fs.writeFile(uri, result.data);
      } catch (err) {
        return {
          content: `generate_image: failed to write ${outPath} — ${String((err as Error)?.message ?? err)}`,
          isError: true
        };
      }

      const rel = vscode.workspace.asRelativePath(uri);
      const revised = result.revisedPrompt
        ? `\nRevised prompt used by the model: ${result.revisedPrompt}`
        : '';
      return {
        content:
          `Generated image saved to ${rel} (${(result.data.length / 1024).toFixed(1)} KB, ${result.mimeType}).` +
          revised,
        meta: { path: uri.toString(), bytes: result.data.length, mimeType: result.mimeType }
      };
    }
  };
}
