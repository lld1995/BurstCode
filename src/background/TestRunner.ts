import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Result of attempting to auto-run a generated unit test. The runner is
 * intentionally conservative: if it cannot find a supported test framework
 * for the given file/language, it returns `status: 'skipped'` with a clear
 * reason rather than guessing.
 */
export interface TestRunResult {
  status: 'passed' | 'failed' | 'skipped' | 'error';
  /** Command line we attempted (for the activity log). */
  command?: string;
  exitCode?: number | null;
  durationMs?: number;
  /** Truncated combined stdout+stderr. */
  output?: string;
  /** Why we skipped or errored without ever spawning. */
  reason?: string;
}

const OUTPUT_HARD_CAP_BYTES = 16 * 1024;

/**
 * Try to run the test file at `testAbsPath` against the workspace at `root`.
 * Always resolves; never throws.
 */
export async function runGeneratedTest(opts: {
  root: string;
  testAbsPath: string;
  language: string;
  timeoutMs: number;
}): Promise<TestRunResult> {
  const { root, testAbsPath, language, timeoutMs } = opts;
  const ext = path.extname(testAbsPath).toLowerCase();
  const lang = (language || '').toLowerCase();

  // ----- TypeScript / JavaScript -----------------------------------------
  if (
    ext === '.ts' || ext === '.tsx' ||
    ext === '.js' || ext === '.jsx' ||
    ext === '.mjs' || ext === '.cjs' ||
    lang === 'typescript' || lang === 'javascript'
  ) {
    const deps = await readPkgDeps(root);
    if (deps.has('vitest')) {
      // vitest accepts a path filter; --run forces single-shot, no watch.
      return spawnRun({
        cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['--no-install', 'vitest', 'run', testAbsPath, '--reporter=verbose'],
        cwd: root,
        timeoutMs
      });
    }
    if (deps.has('jest')) {
      return spawnRun({
        cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['--no-install', 'jest', '--testPathPattern', escapeRegex(testAbsPath), '--colors=false'],
        cwd: root,
        timeoutMs
      });
    }
    return {
      status: 'skipped',
      reason: 'no vitest/jest dependency in package.json — install one to enable auto-run.'
    };
  }

  // ----- Python ----------------------------------------------------------
  if (ext === '.py' || lang === 'python') {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    return spawnRun({
      cmd: py,
      args: ['-m', 'pytest', testAbsPath, '-q'],
      cwd: root,
      timeoutMs
    });
  }

  // ----- Go --------------------------------------------------------------
  // Go's test discovery requires the file to live in the same package as the
  // source under test. Our generated tests live under `.quickcode/tests/` so
  // `go test` cannot import the source via relative paths. Skip and surface
  // the manual command.
  if (ext === '.go' || lang === 'go') {
    return {
      status: 'skipped',
      reason: 'Go tests must live in the source package; review and copy the generated file before running `go test`.'
    };
  }

  return {
    status: 'skipped',
    reason: `auto-run not supported for ${ext || lang || 'this file'}.`
  };
}

/* -------------------------------------------------------------------- */

interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

async function spawnRun(opts: SpawnOptions): Promise<TestRunResult> {
  const started = Date.now();
  const command = `${opts.cmd} ${opts.args.map(quoteArg).join(' ')}`;
  return new Promise<TestRunResult>((resolve) => {
    let buf = Buffer.alloc(0);
    let killed = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    try {
      child = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
        // shell:false; we already pick the .cmd shim on Windows.
        shell: false
      });
    } catch (err) {
      resolve({
        status: 'error',
        command,
        reason: `spawn failed: ${String((err as Error).message ?? err)}`,
        durationMs: Date.now() - started
      });
      return;
    }

    const append = (chunk: Buffer): void => {
      if (buf.length >= OUTPUT_HARD_CAP_BYTES) return;
      const remaining = OUTPUT_HARD_CAP_BYTES - buf.length;
      buf = Buffer.concat([buf, chunk.subarray(0, Math.min(remaining, chunk.length))]);
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    timer = setTimeout(() => {
      killed = true;
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        status: 'error',
        command,
        reason: String(err.message ?? err),
        durationMs: Date.now() - started,
        output: buf.toString('utf8')
      });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const output = buf.toString('utf8');
      if (killed) {
        resolve({
          status: 'error',
          command,
          exitCode: code,
          durationMs: Date.now() - started,
          reason: `timed out after ${opts.timeoutMs}ms (killed)`,
          output
        });
        return;
      }
      resolve({
        status: code === 0 ? 'passed' : 'failed',
        command,
        exitCode: code,
        durationMs: Date.now() - started,
        output
      });
    });
  });
}

async function readPkgDeps(root: string): Promise<Set<string>> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, 'package.json')));
    const json = JSON.parse(Buffer.from(buf).toString('utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const out = new Set<string>();
    Object.keys(json.dependencies ?? {}).forEach((k) => out.add(k));
    Object.keys(json.devDependencies ?? {}).forEach((k) => out.add(k));
    Object.keys(json.optionalDependencies ?? {}).forEach((k) => out.add(k));
    return out;
  } catch {
    return new Set();
  }
}

function quoteArg(a: string): string {
  return /\s/.test(a) ? JSON.stringify(a) : a;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
