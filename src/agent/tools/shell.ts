import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from './types';
import { AskUserFn } from './edits';

type ShellKind = 'auto' | 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh';

interface SpawnPlan {
  exe: string;
  args: string[];
  /**
   * When true the host shell will already do the parsing (we pass the user
   * command as a single argument). When false the caller must already have
   * tokenized argv properly — currently always true for the shells we wire up.
   */
  shellEscaped: boolean;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveCwd(target: string | undefined): string | undefined {
  if (!target) return workspaceRoot();
  if (path.isAbsolute(target)) return target;
  const root = workspaceRoot();
  return root ? path.join(root, target) : target;
}

function shellConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('burstcode.shell');
}

/** Pick the actual executable + argv layout for the requested shell kind. */
function planSpawn(kind: ShellKind, command: string): SpawnPlan {
  const isWin = process.platform === 'win32';
  const resolved: ShellKind =
    kind === 'auto' ? (isWin ? 'powershell' : 'bash') : kind;

  switch (resolved) {
    case 'cmd':
      // /d disables AutoRun, /s+/c keep quoting predictable.
      return { exe: 'cmd.exe', args: ['/d', '/s', '/c', command], shellEscaped: true };
    case 'powershell':
      return {
        exe: 'powershell.exe',
        args: ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command],
        shellEscaped: true
      };
    case 'pwsh':
      return {
        exe: 'pwsh',
        args: ['-NoProfile', '-NoLogo', '-Command', command],
        shellEscaped: true
      };
    case 'bash':
      return { exe: 'bash', args: ['-lc', command], shellEscaped: true };
    case 'sh':
      return { exe: 'sh', args: ['-c', command], shellEscaped: true };
    default:
      // Should be unreachable; fall back to platform default.
      return planSpawn('auto', command);
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  // Coarse truncation by character count is fine — we only need to keep the
  // payload small enough for the LLM to swallow without blowing the context.
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  return { text: buf.toString('utf8'), truncated: true };
}

const ALLOW_ONCE = 'Allow once';
const ALLOW_ALWAYS = 'Allow for this session';
const DENY = 'Deny';

export interface ShellToolDeps {
  askUser: AskUserFn;
}

/**
 * Build the shell-execution tools. Currently exposes a single `run_shell`
 * tool that streams stdout/stderr back as the tool result. Approval is
 * gated through `askUser` unless the user has globally opted into auto-
 * approval via `burstcode.shell.autoApprove` or granted session-wide
 * approval via the prompt.
 */
export function buildShellTools(deps: ShellToolDeps): Tool[] {
  // Per-process session approval. When the user picks "Allow for this
  // session" inside the askUser dialog, we flip this flag so subsequent
  // run_shell calls in the same VS Code window stop prompting. It's reset
  // when the extension reloads / the window is reopened.
  let sessionApproval = false;

  const runShell: Tool = {
    name: 'run_shell',
    // Spawns external processes that mutate disk / environment; never run
    // these in parallel with other tool calls.
    parallelSafe: false,
    schema: {
      type: 'function',
      function: {
        name: 'run_shell',
        description:
          'Execute a shell command on the user\'s machine and return its stdout, stderr, and exit code. ' +
          'Use this to build / test / lint / run scripts, inspect environment state (e.g. `node -v`, `git status`), ' +
          'or to run a script you previously wrote into the workspace via propose_edit. ' +
          'On Windows the default shell is PowerShell; on macOS / Linux it is bash. Pick `shell` explicitly when you need ' +
          'cmd-only syntax (e.g. `dir`, `set`) or POSIX-only (`sh`). The tool BLOCKS until the process exits or the ' +
          'configured timeout fires. By default the user is prompted to approve each command — keep commands short and ' +
          'self-explanatory so they can decide quickly. SAFETY: the command runs with the same privileges as VS Code, so ' +
          'avoid destructive commands unless the user explicitly asked for them. Output is truncated to a configurable ' +
          'byte cap; if you need a full transcript redirect to a file inside the workspace and read it back with read_file.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'The full command line to execute, exactly as you would type it into the chosen shell. Use quoting ' +
                'appropriate for that shell (PowerShell: backtick / single quotes; cmd: caret / double quotes; ' +
                'bash/sh: backslash / single quotes).'
            },
            shell: {
              type: 'string',
              enum: ['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'],
              description:
                'Which shell to invoke. `auto` (default) = powershell on Windows, bash elsewhere. Use `cmd` for ' +
                'Windows-only batch syntax, `pwsh` for cross-platform PowerShell 7+, `bash` / `sh` on POSIX.'
            },
            cwd: {
              type: 'string',
              description:
                'Working directory for the command. Workspace-relative or absolute. Defaults to the workspace root.'
            },
            timeoutMs: {
              type: 'number',
              description:
                'Hard timeout in milliseconds. The process is killed and the call returns isError=true when it elapses. ' +
                'Defaults to burstcode.shell.defaultTimeoutMs (60s). Hard cap: 600000 (10 minutes).'
            },
            reason: {
              type: 'string',
              description:
                'One-sentence explanation shown to the user in the approval prompt — e.g. "list installed npm globals" ' +
                'or "build the C# project to verify the change compiles". Improves the chance the user clicks Allow.'
            }
          },
          required: ['command']
        }
      }
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const cfg = shellConfig();
      if (cfg.get<boolean>('enabled') === false) {
        return {
          content: 'run_shell is disabled by user setting `burstcode.shell.enabled`.',
          isError: true
        };
      }

      const command = String(args.command ?? '').trim();
      if (!command) {
        return { content: 'run_shell: empty command', isError: true };
      }

      const requestedShell = String(args.shell ?? 'auto').toLowerCase() as ShellKind;
      const validShells: ShellKind[] = ['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'];
      const shellKind: ShellKind = validShells.includes(requestedShell) ? requestedShell : 'auto';

      const cwd = resolveCwd(args.cwd ? String(args.cwd) : undefined);
      const reason = args.reason ? String(args.reason).trim() : '';

      const defaultTimeout = clampNumber(cfg.get<number>('defaultTimeoutMs'), 60000, 1000, 600000);
      const timeoutMs = clampNumber(args.timeoutMs, defaultTimeout, 1000, 600000);
      const maxOutputBytes = clampNumber(cfg.get<number>('maxOutputBytes'), 32768, 1024, 524288);
      const autoApprove = cfg.get<boolean>('autoApprove') === true;

      // ---- Approval gate -------------------------------------------------
      if (!autoApprove && !sessionApproval) {
        const promptParts: string[] = [];
        if (reason) promptParts.push(reason);
        promptParts.push(`Shell: ${shellKind} \u2022 cwd: ${cwd ?? '(none)'}`);
        promptParts.push('Command:');
        promptParts.push(command);
        const answer = (
          await deps.askUser({
            question: `Allow BurstCode to execute this command?\n\n${promptParts.join('\n')}`,
            inputType: 'single',
            options: [
              { label: ALLOW_ONCE, description: 'Run this command once.' },
              { label: ALLOW_ALWAYS, description: 'Allow run_shell for the rest of this VS Code session without prompting.' },
              { label: DENY, description: 'Reject this command. Provide a hint via the text field if you want.' }
            ],
            allowCustomText: true,
            placeholder: 'Or type a hint / different instruction…'
          })
        )
          .trim();

        const lower = answer.toLowerCase();
        if (!answer || answer === '(cancelled by user)' || lower.startsWith('deny') || lower.startsWith('no')) {
          return {
            content: `User denied execution of: ${command}${answer && !lower.startsWith('deny') ? `\nUser note: ${answer}` : ''}`,
            isError: true
          };
        }
        if (lower.startsWith(ALLOW_ALWAYS.toLowerCase())) {
          sessionApproval = true;
        } else if (!lower.startsWith(ALLOW_ONCE.toLowerCase())) {
          // Custom text — treat as a redirection from the user.
          return {
            content: `User declined to run the command and provided guidance instead: ${answer}`,
            isError: true
          };
        }
      }

      // ---- Spawn ---------------------------------------------------------
      const plan = planSpawn(shellKind, command);
      const isWin = process.platform === 'win32';
      return await new Promise<ToolResult>((resolve) => {
        let proc: cp.ChildProcess;
        try {
          proc = cp.spawn(plan.exe, plan.args, {
            cwd,
            env: process.env,
            windowsHide: true,
            // Close stdin so commands that read input (npm init, git commit,
            // pause, Read-Host, [Y/n] prompts, …) see EOF immediately and
            // exit instead of blocking the whole tool call forever.
            // Keep stdout/stderr piped so we can capture them.
            stdio: ['ignore', 'pipe', 'pipe'],
            // On POSIX, put the shell in its own process group so we can
            // signal the entire tree (shell + its children) on cancel. On
            // Windows we rely on taskkill /T below instead.
            detached: !isWin
          });
        } catch (err) {
          resolve({
            content: `Failed to spawn ${plan.exe}: ${String((err as Error).message ?? err)}`,
            isError: true
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        const stdoutCap = maxOutputBytes;
        const stderrCap = maxOutputBytes;
        let timedOut = false;
        let settled = false;
        let forcedExit = false;

        // Kill the shell AND every descendant it spawned. On Windows the
        // grandchildren (npm.exe, node.exe, …) do not die when the shell
        // does and they keep the inherited stdout/stderr pipes open, which
        // means proc.on('close') never fires and the Promise hangs forever.
        // taskkill /T /F walks the whole tree and terminates each one.
        // On POSIX we kill the negative pid (process group) we created via
        // detached:true.
        const killTree = (): void => {
          if (proc.exitCode !== null && proc.signalCode === null) return;
          if (isWin) {
            if (typeof proc.pid === 'number') {
              try {
                cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
                  windowsHide: true,
                  stdio: 'ignore'
                }).on('error', () => {
                  /* fall back to direct kill below */
                  try { proc.kill(); } catch { /* ignore */ }
                });
              } catch {
                try { proc.kill(); } catch { /* ignore */ }
              }
            } else {
              try { proc.kill(); } catch { /* ignore */ }
            }
          } else {
            // Negative pid => signal whole process group.
            const pid = proc.pid;
            try {
              if (typeof pid === 'number') process.kill(-pid, 'SIGTERM');
              else proc.kill('SIGTERM');
            } catch {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
            }
            setTimeout(() => {
              if (proc.exitCode === null) {
                try {
                  if (typeof pid === 'number') process.kill(-pid, 'SIGKILL');
                  else proc.kill('SIGKILL');
                } catch { /* ignore */ }
              }
            }, 2000);
          }
        };

        const timer = setTimeout(() => {
          timedOut = true;
          killTree();
          // Belt-and-braces: even if killTree fails to kill a zombie process
          // (e.g. cmd.exe -> npm install -> node.exe with inherited pipe),
          // force-resolve so the agent doesn't hang. 5s is enough for
          // taskkill/SIGTERM to finish in normal cases.
          setTimeout(() => {
            if (!settled) {
              forcedExit = true;
              proc.emit('close', null, 'SIGTERM');
            }
          }, 5000);
        }, timeoutMs);

        const cancelSub = ctx.cancellation.onCancellationRequested(() => {
          killTree();
          // Belt-and-braces: same forced-resolve as the timeout path above.
          setTimeout(() => {
            if (!settled) {
              forcedExit = true;
              proc.emit('close', null, 'SIGTERM');
            }
          }, 5000);
        });

        proc.stdout?.on('data', (chunk: Buffer) => {
          if (Buffer.byteLength(stdout, 'utf8') < stdoutCap) {
            stdout += chunk.toString('utf8');
          }
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          if (Buffer.byteLength(stderr, 'utf8') < stderrCap) {
            stderr += chunk.toString('utf8');
          }
        });

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelSub.dispose();
          resolve({
            content: `Failed to spawn ${plan.exe}: ${String(err.message)}`,
            isError: true
          });
        });

        proc.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelSub.dispose();

          const cancelled = ctx.cancellation.isCancellationRequested;
          const stdoutTrunc = truncate(stdout, stdoutCap);
          const stderrTrunc = truncate(stderr, stderrCap);
          const exitLabel = forcedExit
            ? 'forced (descendant kept stdio open)'
            : code === null
              ? 'null'
              : String(code);
          const headerLines = [
            `# command: ${command}`,
            `# shell: ${shellKind} (${plan.exe})`,
            `# cwd: ${cwd ?? '(default)'}`,
            `# exit: ${exitLabel}${signal ? ` signal=${signal}` : ''}${timedOut ? ' (timed out)' : ''}${cancelled ? ' (cancelled by user)' : ''}`
          ];
          const sections: string[] = [headerLines.join('\n')];
          sections.push(
            `## stdout${stdoutTrunc.truncated ? ' (truncated)' : ''}\n${stdoutTrunc.text || '(empty)'}`
          );
          sections.push(
            `## stderr${stderrTrunc.truncated ? ' (truncated)' : ''}\n${stderrTrunc.text || '(empty)'}`
          );

          resolve({
            content: sections.join('\n\n'),
            isError: timedOut || cancelled || forcedExit || (typeof code === 'number' && code !== 0),
            meta: {
              exitCode: code,
              signal: signal ?? null,
              timedOut,
              cancelled,
              forcedExit,
              shell: shellKind,
              executable: plan.exe,
              cwd: cwd ?? null,
              stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
              stderrBytes: Buffer.byteLength(stderr, 'utf8'),
              stdoutTruncated: stdoutTrunc.truncated,
              stderrTruncated: stderrTrunc.truncated
            }
          });
        });
      });
    }
  };

  return [runShell];
}
