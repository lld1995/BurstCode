import * as vscode from 'vscode';
import * as path from 'path';
import { AgentLoop, AgentOptions } from '../AgentLoop';
import { ChatMessage, OpenAIClient } from '../../llm/OpenAIClient';
import { HunkApplier } from '../../edits/HunkApplier';
import { Logger } from '../../util/Logger';
import { Tool, ToolResult, ToolContext } from './types';

interface SubagentTask {
  id: string;
  objective: string;
  mode: 'read' | 'write';
  independent: boolean;
  allowedFiles: string[];
  context: string;
}

export interface SubagentToolOptions {
  clientFactory: () => OpenAIClient;
  logger: Logger;
  applier: HunkApplier;
  readTools: Tool[];
  writeTools: Tool[];
  systemPrompt: string;
  contextWindow: number;
  maxIterations: number;
  maxConcurrent: number;
  maxTasksPerCall: number;
  enableWrites: boolean;
}

export function buildSubagentTool(options: SubagentToolOptions): Tool {
  let active = 0;
  const waiters: Array<(value: void) => void> = [];

  async function acquire(cancellation?: vscode.CancellationToken): Promise<void> {
    if (active < options.maxConcurrent) {
      active++;
      return;
    }
    // If cancellation is already requested, bail immediately.
    if (cancellation?.isCancellationRequested) {
      throw new Error('Subagent acquire cancelled');
    }
    await new Promise<void>((resolve, reject) => {
      waiters.push(resolve);
      // If a cancellation token is provided, set up a listener so that
      // stuck sub-agents don't leak semaphore slots.
      if (cancellation) {
        const sub = cancellation.onCancellationRequested(() => {
          // Remove ourselves from the waiter queue.
          const idx = waiters.indexOf(resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          sub.dispose();
          reject(new Error('Subagent acquire cancelled'));
        });
      }
    });
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active = Math.max(0, active - 1);
  }

  async function withPermit<T>(fn: () => Promise<T>, cancellation?: vscode.CancellationToken): Promise<T> {
    await acquire(cancellation);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    name: 'launch_subagent',
    parallelSafe: true,
    schema: {
      type: 'function',
      function: {
        name: 'launch_subagent',
        description:
          'Run multiple focused sub-agents concurrently. Use this to speed up independent code understanding tasks and independent per-file writing tasks. For write tasks, set mode="write", independent=true, and allowedFiles to the exact file paths that sub-agent may edit. Do not use write mode when tasks share unsettled interfaces or need to coordinate implementation details; first define the interface contract in the parent turn, then fan out independent files.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short stable id such as read-api, write-view, write-tests.' },
                  objective: { type: 'string', description: 'Concrete objective for this sub-agent.' },
                  mode: { type: 'string', enum: ['read', 'write'], description: 'Default read. Write enables propose_edit only for allowedFiles.' },
                  independent: { type: 'boolean', description: 'Required true for write tasks. Means this task can be solved without reading another sub-agent result.' },
                  allowedFiles: { type: 'array', items: { type: 'string' }, description: 'Required for write tasks. Exact workspace-relative or absolute files this sub-agent may edit.' },
                  context: { type: 'string', description: 'Optional constraints, interface contract, or parent findings.' }
                },
                required: ['id', 'objective']
              }
            },
            maxConcurrent: { type: 'number', description: 'Optional per-call cap, clamped by burstcode.agent.maxConcurrentSubagents.' }
          },
          required: ['tasks']
        }
      }
    },
    async execute(args, ctx): Promise<ToolResult> {
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks = rawTasks.map(parseTask).filter((t): t is SubagentTask => !!t).slice(0, options.maxTasksPerCall);
      if (tasks.length === 0) return { content: 'launch_subagent requires at least one valid task.', isError: true };

      const requestedConcurrent = Number(args.maxConcurrent);
      const perCallLimit = Number.isFinite(requestedConcurrent) && requestedConcurrent > 0
        ? Math.min(options.maxConcurrent, Math.floor(requestedConcurrent))
        : options.maxConcurrent;
      const results: string[] = new Array(tasks.length);
      let cursor = 0;
      let running = 0;

      await new Promise<void>((resolve) => {
        const pump = () => {
          if (ctx.cancellation.isCancellationRequested) {
            resolve();
            return;
          }
          while (running < perCallLimit && cursor < tasks.length) {
            const idx = cursor++;
            running++;
            withPermit(() => runTask(tasks[idx], options, ctx.cancellation), ctx.cancellation)
              .then((result) => {
                results[idx] = result;
              })
              .catch((err) => {
                results[idx] = `[${tasks[idx].id}] error\n${String(err)}`;
              })
              .finally(() => {
                running--;
                if (cursor >= tasks.length && running === 0) resolve();
                else pump();
              });
          }
          if (cursor >= tasks.length && running === 0) resolve();
        };
        pump();
      });

      if (ctx.cancellation.isCancellationRequested) {
        return { content: results.filter(Boolean).join('\n\n') || 'launch_subagent cancelled.', isError: true };
      }

      const completed = results.filter(Boolean);
      const hasError = completed.some((r) => /\] (?:error|rejected|completed_with_errors)/.test(r));
      return {
        content: completed.join('\n\n'),
        isError: hasError,
        meta: { tasks: tasks.map((t) => ({ id: t.id, mode: t.mode, allowedFiles: t.allowedFiles })) }
      };
    }
  };
}

function parseTask(raw: unknown): SubagentTask | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const id = String(rec.id ?? '').trim();
  const objective = String(rec.objective ?? '').trim();
  if (!id || !objective) return undefined;
  const mode = String(rec.mode ?? 'read') === 'write' ? 'write' : 'read';
  const allowedFiles = Array.isArray(rec.allowedFiles)
    ? rec.allowedFiles.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  return {
    id,
    objective,
    mode,
    independent: rec.independent === true,
    allowedFiles,
    context: String(rec.context ?? '').trim()
  };
}

async function runTask(
  task: SubagentTask,
  options: SubagentToolOptions,
  cancellation: vscode.CancellationToken
): Promise<string> {
  if (task.mode === 'write') {
    if (!options.enableWrites) return `[${task.id}] rejected\nWrite sub-agents are disabled by settings.`;
    if (!task.independent) return `[${task.id}] rejected\nWrite tasks must set independent=true.`;
    if (task.allowedFiles.length === 0) return `[${task.id}] rejected\nWrite tasks must provide allowedFiles.`;
  }

  const tools = task.mode === 'write'
    ? [...options.readTools, ...scopeWriteTools(options.writeTools, task.allowedFiles)]
    : options.readTools;
  const messages: ChatMessage[] = [
    { role: 'system', content: buildTaskSystemPrompt(task, options.systemPrompt) },
    { role: 'user', content: buildTaskUserPrompt(task) }
  ];
  const agent = new AgentLoop(options.clientFactory(), tools, options.applier, options.logger, {
    contextWindow: options.contextWindow,
    maxIterations: options.maxIterations,
    requireConfirmBeforeEdit: true,
    autoContinueOnLength: true,
    maxAutoContinues: 1,
    autoResumeOnStreamError: true,
    maxAutoResumes: 1,
    maxStuckRepeats: 1,
    autoContinueOnPrematureStop: true,
    maxPrematureStopContinues: 2,
    systemPrompt: buildTaskSystemPrompt(task, options.systemPrompt)
  } satisfies AgentOptions);

  let lastAssistant = '';
  let toolCalls = 0;
  let errors = 0;
  let doneReason = 'unknown';
  for await (const event of agent.run(messages, cancellation)) {
    if (event.type === 'assistant-message') {
      const payload = event.payload as { text?: unknown } | undefined;
      lastAssistant = String(payload?.text ?? '').trim() || lastAssistant;
    } else if (event.type === 'tool-call-end') {
      toolCalls++;
      const payload = event.payload as { isError?: unknown } | undefined;
      if (payload?.isError) errors++;
    } else if (event.type === 'done') {
      const payload = event.payload as { reason?: unknown } | undefined;
      doneReason = String(payload?.reason ?? doneReason);
    } else if (event.type === 'error') {
      errors++;
      lastAssistant = `${lastAssistant}\n${String(event.payload ?? '')}`.trim();
    }
  }

  const report = lastAssistant || '(no final report produced)';
  const status = errors > 0 ? 'completed_with_errors' : 'completed';
  const fileLine = task.allowedFiles.length ? `\nfiles: ${task.allowedFiles.join(', ')}` : '';
  return `[${task.id}] ${status} mode=${task.mode} reason=${doneReason} toolCalls=${toolCalls}${fileLine}\n${report}`;
}

function buildTaskSystemPrompt(task: SubagentTask, parentSystemPrompt: string): string {
  const writePolicy = task.mode === 'write'
    ? `You may propose edits ONLY to these files: ${task.allowedFiles.join(', ')}. Use propose_edit for all code changes. Do not edit or create any other file.`
    : 'Read-only task. Do not call propose_edit or attempt to modify files.';
  return `${parentSystemPrompt}\n\n<subagent_policy>\nYou are a focused sub-agent running inside BurstCode. Work only on the assigned objective. Do not ask the user questions. Do not update the parent plan. Return a concise report with files inspected, key findings, and any edits queued. ${writePolicy}\n</subagent_policy>`;
}

function buildTaskUserPrompt(task: SubagentTask): string {
  const context = task.context ? `\n\nParent context / contract:\n${task.context}` : '';
  const files = task.allowedFiles.length ? `\n\nAllowed files:\n${task.allowedFiles.join('\n')}` : '';
  return `Sub-agent task ${task.id}:\n${task.objective}${context}${files}`;
}

function scopeWriteTools(tools: Tool[], allowedFiles: string[]): Tool[] {
  const allowed = new Set(allowedFiles.map(normalizePathForCompare));
  return tools.map((tool) => {
    if (tool.name !== 'propose_edit') return tool;
    return {
      ...tool,
      execute: async (args, ctx) => {
        const rawEdits = Array.isArray(args.edits) ? args.edits : [];
        const denied: string[] = [];
        for (const edit of rawEdits) {
          if (!edit || typeof edit !== 'object') continue;
          const p = String((edit as Record<string, unknown>).path ?? '').trim();
          if (!p || !allowed.has(normalizePathForCompare(p))) denied.push(p || '(missing path)');
        }
        if (denied.length > 0) {
          return {
            content: `propose_edit denied by sub-agent file scope. Allowed: ${allowedFiles.join(', ')}. Denied: ${denied.join(', ')}`,
            isError: true
          };
        }
        return tool.execute(args, ctx);
      }
    } satisfies Tool;
  });
}

function normalizePathForCompare(input: string): string {
  let fsPath: string;
  if (input.startsWith('file:')) {
    fsPath = vscode.Uri.parse(input).fsPath;
  } else if (path.isAbsolute(input)) {
    fsPath = input;
  } else {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    fsPath = path.join(root, input);
  }
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
