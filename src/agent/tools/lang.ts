import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';

/**
 * Language-specific tools that wrap private commands of language extensions.
 * They are no-ops (returning isError) when the host extension is not installed.
 */
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
        return { content: `avalonia preview failed: ${String(e)}`, isError: true };
      }
    }
  };

  const dotnetBuild: Tool = {
    name: 'dotnet_build',
    schema: {
      type: 'function',
      function: {
        name: 'dotnet_build',
        description: 'Build the active .NET project to validate the code compiles. Requires C# Dev Kit.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute(): Promise<ToolResult> {
      if (!vscode.extensions.getExtension('ms-dotnettools.csdevkit')) {
        return { content: 'C# Dev Kit not installed', isError: true };
      }
      try {
        await vscode.commands.executeCommand('dotnet.build');
        return { content: 'dotnet build triggered' };
      } catch (e) {
        return { content: `dotnet build failed: ${String(e)}`, isError: true };
      }
    }
  };

  return [eslintFix, avaloniaPreview, dotnetBuild];
}
