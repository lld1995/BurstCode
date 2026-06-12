import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';
import { LspBridge } from '../../lsp/LspBridge';
import { DependencyGuard } from '../../deps/DependencyGuard';

function resolveUri(target: string): vscode.Uri {
  if (target.startsWith('file:')) return vscode.Uri.parse(target);
  if (path.isAbsolute(target)) return vscode.Uri.file(target);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open.');
  return vscode.Uri.file(path.join(root, target));
}

async function ensureLanguageReady(
  uri: vscode.Uri,
  guard: DependencyGuard,
  bridge: LspBridge
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const ready = await guard.ensureForLanguage(doc.languageId);
  if (!ready.ok) {
    return {
      ok: false,
      reason: `Language plugin missing: ${ready.missing.join(', ')}. Pack: ${ready.pack?.label ?? doc.languageId}.`
    };
  }
  await bridge.waitForLanguage(doc.languageId);
  return { ok: true };
}

function formatLocations(locs: vscode.Location[]): string {
  return locs
    .map((l) => {
      const rel = vscode.workspace.asRelativePath(l.uri);
      return `${rel}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
    })
    .join('\n');
}

async function snippetForLocation(loc: vscode.Location, padLines = 3): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(loc.uri);
  const start = Math.max(0, loc.range.start.line - padLines);
  const end = Math.min(doc.lineCount - 1, loc.range.end.line + padLines);
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    lines.push(`${(i + 1).toString().padStart(5)}\t${doc.lineAt(i).text}`);
  }
  return `${vscode.workspace.asRelativePath(loc.uri)} (${start + 1}-${end + 1}):\n${lines.join('\n')}`;
}

export function buildLspTools(bridge: LspBridge, guard: DependencyGuard): Tool[] {
  const findReferences: Tool = {
    name: 'find_references',
    schema: {
      type: 'function',
      function: {
        name: 'find_references',
        description:
          `Find all references to the symbol at (line, character) using the language server. Returns file:line locations and short surrounding snippets. PREFER this over grep_search for symbol usage in typed languages — the LSP understands scopes, overloads and re-exports. If you don't already know the (line, character), call find_references_by_name instead.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'number', description: '1-indexed' },
            character: { type: 'number', description: '1-indexed' },
            includeSnippets: { type: 'boolean', description: 'Default true' }
          },
          required: ['path', 'line', 'character']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const pos = new vscode.Position(Math.max(0, Number(args.line) - 1), Math.max(0, Number(args.character) - 1));
      const refs = await bridge.references(uri, pos);
      const includeSnippets = args.includeSnippets !== false;
      const header = `# references (${refs.length})\n${formatLocations(refs)}`;
      if (!includeSnippets || refs.length === 0) return { content: header, meta: { count: refs.length } };
      const snippets = await Promise.all(refs.slice(0, 20).map((r) => snippetForLocation(r)));
      return { content: `${header}\n\n${snippets.join('\n\n')}`, meta: { count: refs.length } };
    }
  };

  const findDefinition: Tool = {
    name: 'find_definition',
    schema: {
      type: 'function',
      function: {
        name: 'find_definition',
        description: `Jump to the definition of the symbol at (line, character). PREFER this over read_file + grep_search for "where is X defined?" questions — it follows imports and re-exports correctly.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' }
          },
          required: ['path', 'line', 'character']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const pos = new vscode.Position(Number(args.line) - 1, Number(args.character) - 1);
      const defs = await bridge.definition(uri, pos);
      const snippets = await Promise.all(defs.slice(0, 5).map((d) => snippetForLocation(d, 5)));
      return {
        content: `# definitions (${defs.length})\n${formatLocations(defs)}\n\n${snippets.join('\n\n')}`,
        meta: { count: defs.length }
      };
    }
  };

  const findImplementations: Tool = {
    name: 'find_implementations',
    schema: {
      type: 'function',
      function: {
        name: 'find_implementations',
        description: `Find concrete implementations of an interface, abstract method, or trait at (line, character). PREFER this over grep_search when answering "what implements I?".`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' }
          },
          required: ['path', 'line', 'character']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const pos = new vscode.Position(Number(args.line) - 1, Number(args.character) - 1);
      const impls = await bridge.implementations(uri, pos);
      return {
        content: `# implementations (${impls.length})\n${formatLocations(impls)}`,
        meta: { count: impls.length }
      };
    }
  };

  const documentSymbols: Tool = {
    name: 'document_symbols',
    schema: {
      type: 'function',
      function: {
        name: 'document_symbols',
        description: `Return the symbol outline of a file (functions, classes, members) with line ranges. ALWAYS call this BEFORE read_file when you need to navigate a non-trivial file — it is much cheaper than reading the whole file and tells you exactly which line range to read next.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const symbols = await bridge.documentSymbols(uri);
      const lines: string[] = [];
      const walk = (syms: vscode.DocumentSymbol[], depth: number): void => {
        for (const s of syms) {
          lines.push(
            `${'  '.repeat(depth)}${vscode.SymbolKind[s.kind]} ${s.name}  [${s.range.start.line + 1}-${s.range.end.line + 1}]`
          );
          if (s.children?.length) walk(s.children, depth + 1);
        }
      };
      walk(symbols, 0);
      return {
        content: `# symbols of ${vscode.workspace.asRelativePath(uri)}\n${lines.join('\n') || '(empty)'}`,
        meta: { count: lines.length }
      };
    }
  };

  const workspaceSymbols: Tool = {
    name: 'workspace_symbols',
    schema: {
      type: 'function',
      function: {
        name: 'workspace_symbols',
        description: `Search symbols across the workspace by NAME (functions, classes, methods, variables, ...). PREFER this over grep_search when looking up a symbol you only know by name — it returns kind + precise file:line, not raw text matches.`,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, maxResults: { type: 'number' } },
          required: ['query']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const max = Math.min(Number(args.maxResults) || 50, 200);
      const symbols = await bridge.workspaceSymbols(String(args.query));
      const lines = symbols.slice(0, max).map((s) => {
        const rel = vscode.workspace.asRelativePath(s.location.uri);
        return `${vscode.SymbolKind[s.kind]} ${s.name}  ${rel}:${s.location.range.start.line + 1}`;
      });
      return {
        content: `# workspace symbols (${symbols.length})\n${lines.join('\n')}`,
        meta: { count: symbols.length }
      };
    }
  };

  const hoverInfo: Tool = {
    name: 'hover_info',
    schema: {
      type: 'function',
      function: {
        name: 'hover_info',
        description: `Get type / signature / docstring for the symbol at (line, character). PREFER this over read_file when the question is "what type is X?" or "what does this function return?".`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' }
          },
          required: ['path', 'line', 'character']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const pos = new vscode.Position(Number(args.line) - 1, Number(args.character) - 1);
      const hovers = await bridge.hover(uri, pos);
      const text = hovers
        .map((h) =>
          h.contents
            .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : String(c)))
            .join('\n')
        )
        .join('\n---\n');
      return { content: text || '(no hover info)', meta: { count: hovers.length } };
    }
  };

  const getFunctionRange: Tool = {
    name: 'get_function_range',
    schema: {
      type: 'function',
      function: {
        name: 'get_function_range',
        description:
          'Return the start/end line range of the function or method that contains the given line, plus its body.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            line: { type: 'number', description: '1-indexed line inside the function.' }
          },
          required: ['path', 'line']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const uri = resolveUri(String(args.path));
      const status = await ensureLanguageReady(uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };
      const targetLine = Number(args.line) - 1;
      const symbols = await bridge.documentSymbols(uri);
      const containing = findContaining(symbols, targetLine);
      if (!containing) return { content: '(no enclosing function)', isError: true };
      const doc = await vscode.workspace.openTextDocument(uri);
      const start = containing.range.start.line;
      const end = Math.min(doc.lineCount - 1, containing.range.end.line);
      const body: string[] = [];
      for (let i = start; i <= end; i++) {
        body.push(`${(i + 1).toString().padStart(5)}\t${doc.lineAt(i).text}`);
      }
      return {
        content: `# ${vscode.SymbolKind[containing.kind]} ${containing.name} [${start + 1}-${end + 1}]\n${body.join('\n')}`,
        meta: { name: containing.name, start: start + 1, end: end + 1 }
      };
    }
  };

  const findReferencesByName: Tool = {
    name: 'find_references_by_name',
    schema: {
      type: 'function',
      function: {
        name: 'find_references_by_name',
        description:
          'High-level: find all references to a symbol by NAME, no need to know its file/line. Internally calls workspace_symbols to locate the symbol, then find_references on the best match. PREFER this over grep_search when looking up usages of a typed symbol (function, class, method, variable, interface) — the LSP understands scopes, overloads and cross-file imports. Returns file:line locations + short snippets.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact or partial symbol name, e.g. "ChatViewProvider", "buildLspTools".'
            },
            kind: {
              type: 'string',
              description:
                'Optional symbol kind filter to disambiguate. One of: function, method, class, interface, struct, enum, variable, property, field, constructor, constant.'
            },
            fileHint: {
              type: 'string',
              description:
                'Optional file path / substring to disambiguate when multiple symbols share the name (e.g. "src/agent").'
            },
            maxResults: {
              type: 'number',
              description: 'Max references to return (default 50, capped at 200).'
            },
            includeSnippets: {
              type: 'boolean',
              description: 'Include short surrounding code snippets per reference (default true).'
            }
          },
          required: ['name']
        }
      }
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const name = String(args.name ?? '').trim();
      if (!name) return { content: 'name is required', isError: true };
      const kindFilter = args.kind ? matchSymbolKind(String(args.kind)) : undefined;
      const fileHint = args.fileHint ? String(args.fileHint).toLowerCase() : undefined;
      const max = Math.min(Number(args.maxResults) || 50, 200);
      const includeSnippets = args.includeSnippets !== false;

      let candidates = await bridge.workspaceSymbols(name);
      // Fallback: some providers miss exact-name queries but match a shorter
      // prefix. Retry with the leading portion of the name before giving up.
      if (candidates.length === 0 && name.length > 4) {
        const prefixQuery = name.slice(0, Math.max(4, Math.ceil(name.length / 2)));
        const byPrefix = await bridge.workspaceSymbols(prefixQuery);
        candidates = byPrefix.filter((s) => s.name.includes(name) || name.includes(s.name));
      }
      // Workspace-symbol providers can be empty while a language server is still
      // indexing or when a symbol is not exported/top-level. In that case, scan
      // likely source files that contain the requested text and ask their
      // document-symbol providers for a precise position before running refs.
      if (candidates.length === 0) {
        candidates = await findDocumentSymbolCandidates(name, bridge, kindFilter, fileHint);
      }
      if (candidates.length === 0) {
        return {
          content: `# no workspace symbols matched "${name}"\nTried workspace symbols, prefix workspace-symbol search, and local document-symbol fallback, but no matching symbol was found. The language server may still be indexing, the symbol may be generated/dynamic, or the name/path hint may be wrong. Try a partial name, pass fileHint, or fall back to grep_search.`,
          isError: true
        };
      }

      // Score candidates: exact-name > prefix > substring; with optional
      // kind / file-hint filters layered on.
      let pool = candidates.slice();
      if (kindFilter !== undefined) {
        const filtered = pool.filter((s) => s.kind === kindFilter);
        if (filtered.length > 0) pool = filtered;
      }
      if (fileHint) {
        const filtered = pool.filter((s) =>
          vscode.workspace.asRelativePath(s.location.uri).toLowerCase().includes(fileHint)
        );
        if (filtered.length > 0) pool = filtered;
      }
      const exact = pool.filter((s) => s.name === name);
      const prefix = pool.filter((s) => s.name.startsWith(name) && !exact.includes(s));
      const ranked = [...exact, ...prefix, ...pool.filter((s) => !exact.includes(s) && !prefix.includes(s))];
      const pick = ranked[0];

      const status = await ensureLanguageReady(pick.location.uri, guard, bridge);
      if (!status.ok) return { content: status.reason, isError: true };

      const refs = await bridge.references(pick.location.uri, pick.location.range.start);
      const shown = refs.slice(0, max);
      const pickedRel = vscode.workspace.asRelativePath(pick.location.uri);
      const altCount = ranked.length - 1;
      const altNote =
        altCount > 0
          ? `\n(${altCount} other symbol${altCount === 1 ? '' : 's'} matched the name; pass fileHint or kind to disambiguate.)`
          : '';
      const header = `# references to ${vscode.SymbolKind[pick.kind]} ${pick.name}\n  picked: ${pickedRel}:${pick.location.range.start.line + 1}:${pick.location.range.start.character + 1}${altNote}\n  total: ${refs.length}, showing: ${shown.length}`;

      if (shown.length === 0) {
        return { content: `${header}\n(no references found)`, meta: { count: 0, picked: pick.name } };
      }
      const locs = formatLocations(shown);
      if (!includeSnippets) {
        return {
          content: `${header}\n${locs}`,
          meta: { count: refs.length, picked: pick.name, file: pickedRel }
        };
      }
      const snippets = await Promise.all(shown.slice(0, 20).map((r) => snippetForLocation(r)));
      return {
        content: `${header}\n${locs}\n\n${snippets.join('\n\n')}`,
        meta: { count: refs.length, picked: pick.name, file: pickedRel }
      };
    }
  };

  return [
    findReferencesByName,
    findReferences,
    findDefinition,
    findImplementations,
    documentSymbols,
    workspaceSymbols,
    hoverInfo,
    getFunctionRange
  ];
}

function matchSymbolKind(s: string): vscode.SymbolKind | undefined {
  const map: Record<string, vscode.SymbolKind> = {
    function: vscode.SymbolKind.Function,
    method: vscode.SymbolKind.Method,
    class: vscode.SymbolKind.Class,
    interface: vscode.SymbolKind.Interface,
    struct: vscode.SymbolKind.Struct,
    enum: vscode.SymbolKind.Enum,
    enummember: vscode.SymbolKind.EnumMember,
    variable: vscode.SymbolKind.Variable,
    property: vscode.SymbolKind.Property,
    field: vscode.SymbolKind.Field,
    constructor: vscode.SymbolKind.Constructor,
    constant: vscode.SymbolKind.Constant,
    namespace: vscode.SymbolKind.Namespace,
    module: vscode.SymbolKind.Module,
    object: vscode.SymbolKind.Object
  };
  return map[s.toLowerCase().replace(/[\s_-]/g, '')];
}

async function findDocumentSymbolCandidates(
  name: string,
  bridge: LspBridge,
  kindFilter?: vscode.SymbolKind,
  fileHint?: string
): Promise<vscode.SymbolInformation[]> {
  const files = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,mjs,cjs,cs,py,vue,go,rs,java,kt,kts,cpp,c,h,hpp,xaml,axaml}',
    '**/{node_modules,.git,out,dist,build,bin,obj,coverage,.next,.nuxt}/**',
    2000
  );
  const wanted = name.toLowerCase();
  const sorted = files.sort((a, b) => scoreUriForFallback(b, wanted, fileHint) - scoreUriForFallback(a, wanted, fileHint));
  const matches: vscode.SymbolInformation[] = [];

  for (const uri of sorted) {
    if (fileHint && !vscode.workspace.asRelativePath(uri).toLowerCase().includes(fileHint)) continue;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (!doc.getText().toLowerCase().includes(wanted)) continue;
    const symbols = await bridge.documentSymbols(uri);
    collectMatchingSymbols(symbols, name, uri, matches, kindFilter);
    if (matches.length >= 200) break;
  }
  return matches;
}

function scoreUriForFallback(uri: vscode.Uri, wanted: string, fileHint?: string): number {
  const rel = vscode.workspace.asRelativePath(uri).toLowerCase();
  let score = 0;
  if (fileHint && rel.includes(fileHint)) score += 100;
  if (path.basename(rel, path.extname(rel)).includes(wanted)) score += 20;
  if (rel.includes(wanted)) score += 5;
  return score;
}

function collectMatchingSymbols(
  symbols: vscode.DocumentSymbol[],
  name: string,
  uri: vscode.Uri,
  out: vscode.SymbolInformation[],
  kindFilter?: vscode.SymbolKind,
  containerName = ''
): void {
  const wanted = name.toLowerCase();
  for (const symbol of symbols) {
    const symbolName = symbol.name.toLowerCase();
    const matched = symbolName === wanted || symbolName.includes(wanted) || wanted.includes(symbolName);
    if (matched && (kindFilter === undefined || symbol.kind === kindFilter)) {
      out.push(new vscode.SymbolInformation(symbol.name, symbol.kind, containerName, new vscode.Location(uri, symbol.selectionRange)));
    }
    if (symbol.children.length > 0) {
      collectMatchingSymbols(symbol.children, name, uri, out, kindFilter, symbol.name);
    }
  }
}

function findContaining(symbols: vscode.DocumentSymbol[], line: number): vscode.DocumentSymbol | undefined {
  for (const s of symbols) {
    if (s.range.start.line <= line && s.range.end.line >= line) {
      const child = s.children ? findContaining(s.children, line) : undefined;
      if (child && isCallable(child.kind)) return child;
      if (isCallable(s.kind)) return s;
    }
  }
  return undefined;
}

function isCallable(kind: vscode.SymbolKind): boolean {
  return (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor
  );
}
