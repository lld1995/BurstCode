import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { Tool, ToolResult } from './types';

/**
 * Language-specific tools that wrap private commands of language extensions.
 * They are no-ops (returning isError) when the host extension is not installed
 * or when the extension has not yet registered its commands (e.g. not yet
 * activated, or no relevant project is open).
 */

function isCommandNotFound(e: unknown): boolean {
  const msg = String(e).toLowerCase();
  return msg.includes('command') && msg.includes('not found');
}

export function buildLangTools(): Tool[] {
  const eslintFix: Tool = {
    name: 'eslint_fix',
    schema: {
      type: 'function',
      function: {
        name: 'eslint_fix',
        description: 'Run ESLint --fix on the active editor (JS/TS only). Requires dbaeumer.vscode-eslint.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute(): Promise<ToolResult> {
      if (!vscode.extensions.getExtension('dbaeumer.vscode-eslint')) {
        return { content: 'eslint extension not installed', isError: true };
      }
      try {
        await vscode.commands.executeCommand('eslint.executeAutofix');
        return { content: 'eslint auto-fix executed' };
      } catch (e) {
        if (isCommandNotFound(e)) {
          return { content: 'eslint.executeAutofix command not found — extension may not be fully activated. Use run_shell with `npx eslint --fix <file>` instead.', isError: true };
        }
        return { content: `eslint fix failed: ${String(e)}`, isError: true };
      }
    }
  };

  const avaloniaPreview: Tool = {
    name: 'avalonia_preview',
    schema: {
      type: 'function',
      function: {
        name: 'avalonia_preview',
        description: 'Open the Avalonia XAML previewer for the active .axaml file. Requires AvaloniaTeam.vscode-avalonia.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute(): Promise<ToolResult> {
      if (!vscode.extensions.getExtension('AvaloniaTeam.vscode-avalonia')) {
        return { content: 'avalonia extension not installed', isError: true };
      }
      try {
        await vscode.commands.executeCommand('avalonia.preview');
        return { content: 'avalonia preview opened' };
      } catch (e) {
        if (isCommandNotFound(e)) {
          return { content: 'avalonia.preview command not found — extension may not be fully activated or no .axaml file is open.', isError: true };
        }
        return { content: `avalonia preview failed: ${String(e)}`, isError: true };
      }
    }
  };

  const dotnetBuild: Tool = {
    name: 'dotnet_build',
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'dotnet_build',
        description:
          'Run `dotnet build` to compile the .NET project and return the full build output. ' +
          'Optionally specify a project/solution path; otherwise builds from the workspace root.',
        parameters: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description:
                'Workspace-relative path to a .csproj, .sln, or directory to build. ' +
                'Leave empty to build from the workspace root.'
            }
          }
        }
      }
    },
    async execute(args): Promise<ToolResult> {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        return { content: 'No workspace folder open.', isError: true };
      }
      const projectArg = typeof args.project === 'string' && args.project.trim()
        ? args.project.trim()
        : '';
      const cmdArgs = ['build', ...(projectArg ? [projectArg] : [])];
      return new Promise((resolve) => {
        child_process.execFile('dotnet', cmdArgs, { cwd: workspaceRoot, timeout: 120_000 }, (err, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              resolve({ content: '`dotnet` CLI not found in PATH. Ensure the .NET SDK is installed and on PATH.', isError: true });
            } else {
              resolve({ content: `dotnet build failed:\n${output || String(err)}`, isError: true });
            }
          } else {
            resolve({ content: `dotnet build succeeded:\n${output}` });
          }
        });
      });
    }
  };

  return [eslintFix, avaloniaPreview, dotnetBuild];
}
