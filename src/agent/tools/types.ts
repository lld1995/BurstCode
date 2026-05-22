import * as vscode from 'vscode';

/** JSON-schema-ish description for OpenAI tool calling. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolContext {
  cancellation: vscode.CancellationToken;
  emitProgress(message: string): void;
  /** Tool call id of the parent call (set by AgentLoop when executing). */
  callId?: string;
}

export interface ToolResult {
  /** Compact text representation returned to the LLM. */
  content: string;
  /** Optional structured data shown in UI. */
  meta?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  readonly schema: ToolSchema;
  readonly name: string;
  /**
   * Whether this tool is safe to execute concurrently with other tools in the
   * same assistant turn. Defaults to `true` (read-only / pure tools). Tools
   * with user-visible UI side effects or shared mutable state (e.g. queueing
   * edits, asking the user, updating the plan) must opt out by setting this
   * to `false` so the agent loop serializes them.
   */
  readonly parallelSafe?: boolean;
  /**
   * When true, the batch safety timeout in AgentLoop does not apply to this
   * tool. Use for long-running orchestration tools (e.g. launch_subagent)
   * that manage their own cancellation and run time.
   */
  readonly noTimeout?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
