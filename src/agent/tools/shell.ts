import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { TextDecoder } from 'util';
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
  /**
   * When true, decode process output using the Windows system OEM code page
   * instead of UTF-8. Set for cmd.exe on Windows: piped subprocesses have no
   * attached console so SetConsoleOutputCP / chcp have no effect, and native
   * programs (ipconfig, netstat, …) write bytes in the OEM code page.
   */
  useOemDecoder?: boolean;
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
      // NOTE: we do NOT prepend `chcp 65001` here. In piped mode (no attached
      // console) SetConsoleOutputCP silently fails, so the code page change
      // has no effect on child processes like ipconfig.exe. Instead we detect
      // the system OEM code page once and decode on the Node.js side.
      return {
        exe: 'cmd.exe',
        args: ['/d', '/s', '/c', command],
        shellEscaped: true,
        useOemDecoder: isWin
      };
    case 'powershell':
    case 'pwsh': {
      // On Windows, PowerShell's pipe-mode stdout defaults to the system OEM
      // code page. We fix this by prepending a UTF-8 setup block.
      //
      // In .NET Framework (PS 5.x) [Console]::OutputEncoding only rewires
      // Console.Out; Console.Error keeps the OEM encoding. We also call
      // SetError() to cover stderr. Both calls are wrapped in try/catch so
      // they degrade gracefully when the standard streams are not available.
      //
      // LIMITATION: PowerShell parse-time errors (syntax errors detected
      // before any code runs, e.g. using `||` in PS 5.x) will still be in
      // the system OEM encoding because our setup code never executes.
      // The fix for parse errors is to use a shell that accepts the syntax
      // (e.g. shell=pwsh for PS7 which supports ||) or rewrite the command.
      const utf8Block = isWin
        ? `$__e=[System.Text.Encoding]::UTF8;[Console]::OutputEncoding=$__e;$OutputEncoding=$__e;try{$__ew=[System.IO.StreamWriter]::new([Console]::OpenStandardError(),$__e);$__ew.AutoFlush=$true;[Console]::SetError($__ew)}catch{};`
        : '';
      const exe = resolved === 'pwsh' ? 'pwsh' : 'powershell.exe';
      const baseArgs = resolved === 'pwsh'
        ? ['-NoProfile', '-NoLogo', '-Command']
        : ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command'];
      return {
        exe,
        args: [...baseArgs, `${utf8Block}${command}`],
        shellEscaped: true
      };
    }
    case 'bash':
      return { exe: 'bash', args: ['-lc', command], shellEscaped: true };
    case 'sh':
      return { exe: 'sh', args: ['-c', command], shellEscaped: true };
    default:
      // Should be unreachable; fall back to platform default.
      return planSpawn('auto', command);
  }
}

/**
 * Lazily detect the Windows system OEM code page via `chcp` and return an
 * appropriate TextDecoder.  Cached after first call.
 *
 * Background: when Node.js spawns cmd.exe with stdio:'pipe' there is no
 * attached console, so SetConsoleOutputCP / `chcp 65001` silently fails and
 * native programs (ipconfig.exe, netstat.exe, …) keep writing bytes in the
 * system OEM code page (CP936 / GBK on Chinese Windows, CP932 on Japanese, …).
 * We detect the code page once and decode accordingly.
 */
let _winOemDecoder: TextDecoder | undefined;
function getWinOemDecoder(): TextDecoder {
  if (_winOemDecoder !== undefined) return _winOemDecoder;
  if (process.platform !== 'win32') return (_winOemDecoder = new TextDecoder('utf-8'));
  const nameMap: Record<string, string> = {
    '936': 'gb18030', '54936': 'gb18030',   // Chinese Simplified
    '950': 'big5',   '951': 'big5',         // Chinese Traditional
    '932': 'shift_jis',                      // Japanese
    '949': 'euc-kr',                         // Korean
    '1250': 'windows-1250', '1251': 'windows-1251',
    '1252': 'windows-1252', '1253': 'windows-1253',
    '65001': 'utf-8',
  };
  const tryDecode = (cpNum: string): TextDecoder | undefined => {
    const name = nameMap[cpNum] ?? `windows-${cpNum}`;
    try { return new TextDecoder(name); } catch { return undefined; }
  };
  // Primary: read the system OEM code page from the registry.
  // This is the value Windows was configured with at install time and is
  // NOT affected by SetConsoleOutputCP / chcp or Electron overrides.
  try {
    const raw = cp.execFileSync('reg', [
      'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
      '/v', 'OEMCP'
    ], { encoding: 'ascii', timeout: 3000, windowsHide: true }) as unknown as string;
    const m = raw.match(/OEMCP\s+REG_SZ\s+(\d+)/i);
    if (m) {
      const dec = tryDecode(m[1]);
      if (dec) return (_winOemDecoder = dec);
    }
  } catch { /* fall through to chcp probe */ }
  // Fallback: ask the current cmd session what code page it is using.
  try {
    const raw = cp.execFileSync('cmd.exe', ['/d', '/c', 'chcp'], {
      encoding: 'ascii', timeout: 3000, windowsHide: true
    }) as unknown as string;
    const m = raw.match(/(\d+)/);
    if (m) {
      const dec = tryDecode(m[1]);
      if (dec) return (_winOemDecoder = dec);
    }
  } catch { /* probe failed */ }
  return (_winOemDecoder = new TextDecoder('utf-8'));
}

/** Strip ANSI/VT escape sequences and normalise CR for plain-text progress display. */
function stripAnsiForProgress(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')      // CSI sequences (colours, cursor)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (hyperlinks, titles)
    .replace(/\x1b[^[\\]/g, '')                  // other ESC sequences
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
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
          'Execute a shell command and return stdout, stderr, exit code. Use for build/test/lint/run scripts or environment probes (node -v, git status). User approval gate unless auto-approved. See PROTOCOL step 11 for safety rules.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Full command line, quoted for the chosen shell.' },
            shell: {
              type: 'string',
              enum: ['auto', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'],
              description: 'auto=pwsh on Win / bash elsewhere. Override only for shell-specific syntax.'
            },
            cwd: { type: 'string', description: 'Working dir (relative or absolute). Defaults to workspace root.' },
            timeoutMs: { type: 'number', description: 'Hard timeout in ms (default 60000, cap 600000).' },
            reason: { type: 'string', description: 'One-sentence justification shown in the approval prompt.' }
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
      const maxOutputBytes = clampNumber(cfg.get<number>('maxOutputBytes'), 131072, 1024, 524288);
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
          // For OEM-decoded shells (cmd.exe on Windows) we do NOT override
          // Python's encoding: if Python outputs UTF-8 while we decode as
          // GBK/CP936, multi-byte chars would be garbled. Let Python follow
          // the system OEM code page, which our decoder handles correctly.
          // For UTF-8 shells (powershell/pwsh) we keep the UTF-8 hints.
          const childEnv: NodeJS.ProcessEnv = plan.useOemDecoder
            ? { ...process.env }
            : { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
          proc = cp.spawn(plan.exe, plan.args, {
            cwd,
            env: childEnv,
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

        const stdoutCap = maxOutputBytes;
        const stderrCap = maxOutputBytes;
        // Ring-buffer capture: accumulate chunks and evict from the FRONT
        // once the buffer exceeds the cap. On close we take the LAST cap
        // bytes — errors and results live in the tail, not the head.
        const stdoutChunks: Buffer[] = [];
        let stdoutBufBytes = 0;
        let stdoutDropped = false;
        const stderrChunks: Buffer[] = [];
        let stderrBufBytes = 0;
        let stderrDropped = false;
        let timedOut = false;
        let settled = false;
        let forcedExit = false;

        // Real-time progress streaming: accumulate output and flush to the UI
        // every PROGRESS_THROTTLE_MS ms so the user sees live output instead
        // of a frozen bubble. stdout and stderr are combined in arrival order.
        const PROGRESS_THROTTLE_MS = 150;
        let pendingProgressText = '';
        let progressFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const flushProgress = (): void => {
          progressFlushTimer = null;
          if (pendingProgressText) {
            ctx.emitProgress(pendingProgressText);
            pendingProgressText = '';
          }
        };
        const scheduleProgress = (): void => {
          if (!progressFlushTimer) {
            progressFlushTimer = setTimeout(flushProgress, PROGRESS_THROTTLE_MS);
          }
        };

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
          stdoutChunks.push(chunk);
          stdoutBufBytes += chunk.length;
          // Evict oldest chunks while we can still afford to (i.e. we'd
          // still have ≥ cap bytes left after eviction). Memory stays ≤
          // cap + one chunk size at all times.
          while (stdoutChunks.length > 1 && stdoutBufBytes - stdoutChunks[0].length >= stdoutCap) {
            stdoutBufBytes -= stdoutChunks.shift()!.length;
            stdoutDropped = true;
          }
          if (!settled) {
            pendingProgressText += stripAnsiForProgress(
              plan.useOemDecoder ? getWinOemDecoder().decode(chunk) : chunk.toString('utf8')
            );
            scheduleProgress();
          }
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk);
          stderrBufBytes += chunk.length;
          while (stderrChunks.length > 1 && stderrBufBytes - stderrChunks[0].length >= stderrCap) {
            stderrBufBytes -= stderrChunks.shift()!.length;
            stderrDropped = true;
          }
          if (!settled) {
            pendingProgressText += stripAnsiForProgress(
              plan.useOemDecoder ? getWinOemDecoder().decode(chunk) : chunk.toString('utf8')
            );
            scheduleProgress();
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
          // Flush any output buffered by the throttle before resolving so
          // the last lines are visible before the tool-call-end event fires.
          if (progressFlushTimer !== null) { clearTimeout(progressFlushTimer); progressFlushTimer = null; }
          flushProgress();

          const cancelled = ctx.cancellation.isCancellationRequested;
          // Assemble final strings from the ring buffer, taking the LAST
          // cap bytes (tail-biased: errors/results are at the end).
          let stdoutBuf = Buffer.concat(stdoutChunks);
          if (stdoutBuf.length > stdoutCap) {
            stdoutDropped = true;
            stdoutBuf = stdoutBuf.subarray(stdoutBuf.length - stdoutCap);
          }
          const decodeOutput = plan.useOemDecoder
            ? (buf: Buffer) => getWinOemDecoder().decode(buf)
            : (buf: Buffer) => buf.toString('utf8');
          const stdout = decodeOutput(stdoutBuf);
          let stderrBuf = Buffer.concat(stderrChunks);
          if (stderrBuf.length > stderrCap) {
            stderrDropped = true;
            stderrBuf = stderrBuf.subarray(stderrBuf.length - stderrCap);
          }
          const stderr = decodeOutput(stderrBuf);
          const stdoutTrunc = stdoutDropped ? { text: stdout, truncated: true } : { text: stdout, truncated: false };
          const stderrTrunc = stderrDropped ? { text: stderr, truncated: true } : { text: stderr, truncated: false };
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
          const stdoutLabel = stdoutTrunc.truncated
            ? ` (showing last ${stdoutCap} bytes — earlier output omitted)`
            : '';
          const stderrLabel = stderrTrunc.truncated
            ? ` (showing last ${stderrCap} bytes — earlier output omitted)`
            : '';
          sections.push(`## stdout${stdoutLabel}\n${stdoutTrunc.text || '(empty)'}`);
          sections.push(`## stderr${stderrLabel}\n${stderrTrunc.text || '(empty)'}`);

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
