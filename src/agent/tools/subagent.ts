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
  taskTimeoutMs: number;
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
    noTimeout: true,
    schema: {
      type: 'function',
      function: {
        name: 'launch_subagent',
        description:
          'Run focused sub-agents concurrently for independent fan-out tasks. Write tasks require mode="write", independent=true, allowedFiles. See BATCH_PROTOCOL for when to prefer this over inline tool batching.\n\nWHEN TO USE — use launch_subagent only when the work is both independent and broad enough that returning a concise summary is cheaper than injecting raw file content here. Do NOT use it merely because context is high: for ordinary context pressure, narrow reads, compress/truncate stale context, or continue with targeted local tools. Sub-agents have their own LLM loop and are slower than direct tools for small lookups or pre-edit reads.',
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

      ctx.emitProgress(`Starting ${tasks.length} sub-agent task(s): ${tasks.map((t) => t.id).join(', ')}`);

      await new Promise<void>((resolve) => {
        const pump = () => {
          if (ctx.cancellation.isCancellationRequested) {
            resolve();
            return;
          }
          while (running < perCallLimit && cursor < tasks.length) {
            const idx = cursor++;
            running++;
            ctx.emitProgress(`[${tasks[idx].id}] starting (${tasks[idx].mode})`);
            withPermit(
              () => runTask(tasks[idx], options, ctx.cancellation, (msg) => ctx.emitProgress(`[${tasks[idx].id}] ${msg}`)),
              ctx.cancellation
            )
              .then((result) => {
                results[idx] = result;
                ctx.emitProgress(`[${tasks[idx].id}] done`);
              })
              .catch((err) => {
                results[idx] = `[${tasks[idx].id}] error\n${String(err)}`;
                ctx.emitProgress(`[${tasks[idx].id}] error: ${String(err).slice(0, 120)}`);
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
      const hasError = completed.some((r) => /\] (?:error|rejected|partial|completed_with_errors)/.test(r));
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
  cancellation: vscode.CancellationToken,
  onProgress?: (msg: string) => void
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
  const taskTokenSource = new vscode.CancellationTokenSource();
  const parentSub = cancellation.onCancellationRequested(() => taskTokenSource.cancel());
  const timeoutMs = Math.max(1_800_000, Math.floor(options.taskTimeoutMs || 0));
  const timeout = setTimeout(() => taskTokenSource.cancel(), timeoutMs);
  const agent = new AgentLoop(options.clientFactory(), tools, options.applier, options.logger, {
    contextWindow: options.contextWindow,
    maxIterations: options.maxIterations,
    requireConfirmBeforeEdit: true,
    autoContinueOnLength: false,
    maxAutoContinues: 0,
    autoResumeOnStreamError: true,
    maxAutoResumes: 1,
    maxStuckRepeats: 1,
    autoContinueOnPrematureStop: false,
    maxPrematureStopContinues: 0,
    systemPrompt: buildTaskSystemPrompt(task, options.systemPrompt)
  } satisfies AgentOptions);

  // Accumulate ALL assistant turns so partial findings from mid-run iterations
  // are not lost when the sub-agent hits max_iterations or stuck.
  const assistantTurns: string[] = [];
  const toolErrors: string[] = [];
  const toolCallNames: string[] = [];
  let toolCalls = 0;
  let errors = 0;
  let doneReason = 'unknown';
  try {
    for await (const event of agent.run(messages, taskTokenSource.token)) {
      if (event.type === 'assistant-message') {
        const payload = event.payload as { text?: unknown } | undefined;
        const text = String(payload?.text ?? '').trim();
        if (text) assistantTurns.push(text);
      } else if (event.type === 'tool-call-start') {
        const payload = event.payload as { name?: unknown } | undefined;
        onProgress?.(`  → ${String(payload?.name ?? 'tool')}`);
      } else if (event.type === 'tool-call-end') {
        toolCalls++;
        const payload = event.payload as { name?: unknown; isError?: unknown; result?: unknown } | undefined;
        const toolName = String(payload?.name ?? 'tool');
        toolCallNames.push(toolName);
        if (payload?.isError) {
          errors++;
          const errContent = String(payload?.result ?? '').slice(0, 400).trim();
          if (errContent) toolErrors.push(`[${toolName}] ${errContent}`);
        }
        onProgress?.(`  ✓ ${toolName}${payload?.isError ? ' (error)' : ''}`);
      } else if (event.type === 'tool-progress') {
        const payload = event.payload as { message?: unknown } | undefined;
        onProgress?.(String(payload?.message ?? ''));
      } else if (event.type === 'done') {
        const payload = event.payload as { reason?: unknown } | undefined;
        doneReason = String(payload?.reason ?? doneReason);
      } else if (event.type === 'error') {
        errors++;
        const errText = String(event.payload ?? '').trim();
        if (errText) assistantTurns.push(`[error] ${errText}`);
      }
    }
  } finally {
    clearTimeout(timeout);
    parentSub.dispose();
    taskTokenSource.dispose();
  }
  if (!cancellation.isCancellationRequested && doneReason === 'cancelled') {
    doneReason = `timeout_${timeoutMs}ms`;
    errors++;
  }

  const isPartial = doneReason === 'max_iterations' || doneReason === 'stuck';
  const fileLine = task.allowedFiles.length ? `\nfiles: ${task.allowedFiles.join(', ')}` : '';

  if (assistantTurns.length === 0) {
    const status = errors > 0 ? 'completed_with_errors' : 'completed';
    let detail: string;
    if (toolErrors.length > 0) {
      detail = `\nTool errors (${toolErrors.length}):\n${toolErrors.join('\n')}`;
    } else if (toolCallNames.length > 0) {
      const counts = new Map<string, number>();
      for (const n of toolCallNames) counts.set(n, (counts.get(n) ?? 0) + 1);
      const summary = [...counts.entries()].map(([n, c]) => c > 1 ? `${n}×${c}` : n).join(', ');
      detail = `\n(no text report; tools called: ${summary})`;
    } else {
      detail = '\n(no report produced)';
    }
    return `[${task.id}] ${status} mode=${task.mode} reason=${doneReason} toolCalls=${toolCalls}${fileLine}${detail}`;
  }

  // For partial runs (max_iterations / stuck), merge all turns into one clean
  // report — deduplicate identical sentences and strip empty turns, but keep
  // every distinct piece of information the sub-agent found.
  const report = (() => {
    if (!isPartial || assistantTurns.length === 1) return assistantTurns[assistantTurns.length - 1];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const turn of assistantTurns) {
      for (const line of turn.split('\n')) {
        const key = line.trim();
        if (key && !seen.has(key)) {
          seen.add(key);
          lines.push(line);
        }
      }
    }
    return lines.join('\n');
  })();

  const status = isPartial ? 'partial' : errors > 0 ? 'completed_with_errors' : 'completed';
  return `[${task.id}] ${status} mode=${task.mode} reason=${doneReason} toolCalls=${toolCalls}${fileLine}\n${report}`;
}

/**
 * Strip sections from the parent system prompt that reference tools the
 * sub-agent does not have (launch_subagent). Leaving those instructions in
 * causes the sub-agent to attempt calling a non-existent tool, which
 * triggers the stuck-detection loop and terminates the task early.
 *
 * We remove:
 *   - The CONTEXT HYGIENE block (bounded by its heading line and the next
 *     blank-line-then-uppercase-heading or end-of-string).
 *   - Any sentence/bullet that mentions "launch_subagent" in BATCH_PROTOCOL.
 */
function stripSubagentUnsafeSections(prompt: string): string {
  // Remove the entire CONTEXT HYGIENE fenced block.
  // The block starts with a line that begins "CONTEXT HYGIENE" and ends
  // just before the next all-caps section heading or end of string.
  let out = prompt.replace(
    /CONTEXT HYGIENE[\s\S]*?(?=\n[A-Z][A-Z\s\-]{3,}:|$)/g,
    ''
  );
  // Remove individual lines / bullets mentioning launch_subagent.
  out = out
    .split('\n')
    .filter((line) => !/launch_subagent/.test(line))
    .join('\n');
  // Collapse runs of 3+ blank lines left behind by removals.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

function buildTaskSystemPrompt(task: SubagentTask, parentSystemPrompt: string): string {
  const writePolicy = task.mode === 'write'
    ? `You may propose edits ONLY to these files: ${task.allowedFiles.join(', ')}. Use propose_edit for all code changes. Do not edit or create any other file.`
    : 'Read-only task. Do not call propose_edit or attempt to modify files.';
  const safePrompt = stripSubagentUnsafeSections(parentSystemPrompt);
  return `${safePrompt}\n\n<subagent_policy>\nYou are a focused sub-agent running inside BurstCode. Work only on the assigned objective. Do not ask the user questions. Do not update the parent plan. Return a concise report with files inspected, key findings, and any edits queued. ${writePolicy}\n</subagent_policy>`;
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
        const paths = extractProposeEditPaths(args);
        const denied: string[] = [];
        if (paths.length === 0) {
          denied.push('(missing path)');
        } else {
          for (const p of paths) {
            if (!allowed.has(normalizePathForCompare(p))) denied.push(p);
          }
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

const PROPOSE_EDIT_PATH_KEYS = ['path', 'file', 'filePath', 'filename', 'fileName', 'target', 'targetFile', 'uri'];
const PROPOSE_EDIT_ARRAY_KEYS = ['edits', 'hunks', 'changes', 'files'];
const PROPOSE_EDIT_RANGE_ARRAY_KEYS = ['ranges', 'deletions', 'deleteRanges', 'replacements', 'replaceRanges'];

function pickPathValue(record: Record<string, unknown>): string | undefined {
  for (const key of PROPOSE_EDIT_PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractProposeEditPaths(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const topLevelPath = pickPathValue(record);
  const paths: string[] = [];
  const addPath = (value: string | undefined) => {
    const p = String(value ?? '').trim();
    if (p) paths.push(p);
  };

  for (const key of [...PROPOSE_EDIT_ARRAY_KEYS, ...PROPOSE_EDIT_RANGE_ARRAY_KEYS]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        addPath(pickPathValue(item as Record<string, unknown>) ?? topLevelPath);
      } else {
        addPath(topLevelPath);
      }
    }
  }

  if (paths.length === 0) addPath(topLevelPath);
  return [...new Set(paths)];
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
