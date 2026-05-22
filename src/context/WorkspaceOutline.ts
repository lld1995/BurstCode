import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Builds a compact "workspace map" string injected into the agent's system prompt
 * so the model can analyse user intent against the actual project layout before
 * deciding which files to read.
 *
 * Design goals:
 *  - Bounded size (token-friendly): hard cap on bytes; collapse oversized dirs.
 *  - Layered depth: top of repo expanded broadly, source dirs (`src`, `lib`, ...)
 *    drilled deeper because that is where intent usually maps to.
 *  - Respects common build/tooling junk + root .gitignore (best-effort).
 *  - Pure async fs walk — no VS Code API dependency, easy to unit-test.
 */

export interface OutlineOptions {
  /** Recursion depth for ordinary directories (root counts as depth 0). */
  baseDepth: number;
  /** Recursion depth for source-like directories (deeper drill). */
  srcDepth: number;
  /** Directory names treated as source-like and drilled to `srcDepth`. */
  srcDirNames: string[];
  /** Hard exclude (matched by basename, never recurse into these). */
  excludeDirs: Set<string>;
  /** Skip files whose basename matches any of these regexes. */
  excludeFilePatterns: RegExp[];
  /** Collapse directories with more than this many entries. */
  maxEntriesPerDir: number;
  /** When collapsing, how many entries to still show before the fold marker. */
  collapseShown: number;
  /** Soft cap on total characters of the outline. */
  maxBytes: number;
  /** Read the root `.gitignore` and add directory-shaped patterns to excludes. */
  honorRootGitignore: boolean;
}

export const defaultOutlineOptions: OutlineOptions = {
  baseDepth: 2,
  srcDepth: 4,
  srcDirNames: ['src', 'lib', 'app', 'apps', 'packages', 'modules', 'pkg', 'cmd', 'internal'],
  excludeDirs: new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    'out',
    'build',
    'target',
    'bin',
    'obj',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    '.parcel-cache',
    '.venv',
    'venv',
    'env',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    '.idea',
    '.vscode-test',
    'coverage',
    '.nyc_output',
    'tmp',
    'temp',
    '.DS_Store'
  ]),
  excludeFilePatterns: [/\.log$/i, /\.lock$/i, /\.map$/i, /\.min\.(js|css)$/i, /^\.DS_Store$/],
  maxEntriesPerDir: 30,
  collapseShown: 8,
  maxBytes: 4000,
  honorRootGitignore: true
};

export interface OutlineResult {
  /** Rendered tree text, ready to embed in the system prompt. */
  text: string;
  /** Was the walk halted because the byte budget was exhausted? */
  truncated: boolean;
  /** Number of directories visited (rough cost indicator). */
  dirsVisited: number;
}

interface WalkState {
  cfg: OutlineOptions;
  lines: string[];
  bytes: number;
  truncated: boolean;
  dirsVisited: number;
  extraExcludeDirs: Set<string>;
}

export async function buildWorkspaceOutline(
  rootFsPath: string,
  partial: Partial<OutlineOptions> = {}
): Promise<OutlineResult> {
  const cfg: OutlineOptions = {
    ...defaultOutlineOptions,
    ...partial,
    excludeDirs: new Set([...defaultOutlineOptions.excludeDirs, ...(partial.excludeDirs ?? [])]),
    excludeFilePatterns: [
      ...defaultOutlineOptions.excludeFilePatterns,
      ...(partial.excludeFilePatterns ?? [])
    ],
    srcDirNames: partial.srcDirNames ?? defaultOutlineOptions.srcDirNames
  };

  const extraExcludeDirs = cfg.honorRootGitignore
    ? await readGitignoreDirNames(rootFsPath)
    : new Set<string>();

  const rootName = path.basename(rootFsPath) || rootFsPath;
  const state: WalkState = {
    cfg,
    lines: [`${rootName}/`],
    bytes: rootName.length + 2,
    truncated: false,
    dirsVisited: 0,
    extraExcludeDirs
  };

  await walkDir(state, rootFsPath, '  ', 0, cfg.baseDepth);

  if (state.truncated) {
    state.lines.push('... [outline truncated to fit byte budget]');
  }

  return {
    text: state.lines.join('\n'),
    truncated: state.truncated,
    dirsVisited: state.dirsVisited
  };
}

async function walkDir(
  state: WalkState,
  dirAbs: string,
  indent: string,
  depth: number,
  maxDepth: number
): Promise<void> {
  if (state.truncated) return;
  if (depth > maxDepth) return;
  if (state.bytes >= state.cfg.maxBytes) {
    state.truncated = true;
    return;
  }

  state.dirsVisited++;

  let dirents: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await fs.readdir(dirAbs, { withFileTypes: true });
    dirents = raw.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return;
  }

  const filtered = dirents.filter((d) => keepEntry(d, depth, state));

  filtered.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = filtered.length;
  const collapse = total > state.cfg.maxEntriesPerDir;
  const shown = collapse ? filtered.slice(0, state.cfg.collapseShown) : filtered;

  for (const entry of shown) {
    if (state.truncated || state.bytes >= state.cfg.maxBytes) {
      state.truncated = true;
      return;
    }
    await emitEntry(state, dirAbs, entry, indent, depth, maxDepth);
  }

  if (collapse) {
    const hiddenDirs = filtered.slice(shown.length).filter((e) => e.isDir).length;
    const hiddenFiles = filtered.length - shown.length - hiddenDirs;
    appendLine(state, `${indent}[+${hiddenFiles} files & ${hiddenDirs} dirs]`);
  }
}

async function emitEntry(
  state: WalkState,
  parentAbs: string,
  entry: { name: string; isDir: boolean },
  indent: string,
  depth: number,
  maxDepth: number
): Promise<void> {
  if (entry.isDir) {
    appendLine(state, `${indent}${entry.name}/`);
    if (state.truncated) return;

    // Source-like directories at depth 0 get a deeper budget; we extend maxDepth
    // when crossing into them so their grandchildren can still surface.
    const enterSrc = depth === 0 && state.cfg.srcDirNames.includes(entry.name);
    const childMaxDepth = enterSrc
      ? Math.max(maxDepth, state.cfg.srcDepth)
      : maxDepth;

    if (depth + 1 <= childMaxDepth) {
      await walkDir(state, path.join(parentAbs, entry.name), indent + '  ', depth + 1, childMaxDepth);
    }
  } else {
    appendLine(state, `${indent}${entry.name}`);
  }
}

function keepEntry(
  d: { name: string; isDir: boolean },
  depth: number,
  state: WalkState
): boolean {
  const { cfg, extraExcludeDirs } = state;
  if (d.isDir) {
    if (cfg.excludeDirs.has(d.name)) return false;
    if (extraExcludeDirs.has(d.name)) return false;
    // Hidden dirs: keep `.github`, `.vscode`, `.windsurf` at the root only;
    // suppress all other hidden dirs to avoid noise.
    if (d.name.startsWith('.')) {
      const allowedHidden = new Set(['.github', '.vscode', '.windsurf', '.husky']);
      if (depth > 0) return false;
      if (!allowedHidden.has(d.name)) return false;
    }
    return true;
  }
  // File filters
  if (cfg.excludeFilePatterns.some((re) => re.test(d.name))) return false;
  if (d.name.startsWith('.') && !isInterestingDotfile(d.name)) return false;
  return true;
}

function isInterestingDotfile(name: string): boolean {
  // Surface common project-defining dotfiles.
  return (
    name === '.gitignore' ||
    name === '.editorconfig' ||
    name === '.eslintrc' ||
    name === '.prettierrc' ||
    name === '.npmrc' ||
    name === '.nvmrc' ||
    name === '.python-version' ||
    name === '.env.example'
  );
}

function appendLine(state: WalkState, line: string): void {
  if (state.bytes + line.length + 1 > state.cfg.maxBytes) {
    state.truncated = true;
    return;
  }
  state.lines.push(line);
  state.bytes += line.length + 1;
}

/**
 * Best-effort root .gitignore parser. We only extract entries that look like a
 * directory name (no slashes other than a trailing one, no glob wildcards) and
 * add them to the exclude set. This intentionally ignores file-level globs
 * because the outline already filters most build artefacts via defaults.
 */
async function readGitignoreDirNames(rootFsPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(rootFsPath, '.gitignore'), 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Strip trailing slash; treat as directory name pattern.
    const cleaned = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) continue;
    // Reject anything that still looks like a path or glob.
    if (cleaned.includes('/') || cleaned.includes('*') || cleaned.includes('?')) continue;
    out.add(cleaned);
  }
  return out;
}
