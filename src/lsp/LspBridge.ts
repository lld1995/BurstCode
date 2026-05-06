import * as vscode from 'vscode';

/** Thin wrappers around `vscode.execute*Provider` commands. All of them are language-neutral. */
export class LspBridge {
  constructor(private readonly maxWaitMs: number = 60000) {}

  async openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(uri);
  }

  async references(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const result = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      position
    );
    return result ?? [];
  }

  async definition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      uri,
      position
    );
    return (result ?? []).map((r) => this.toLocation(r));
  }

  async implementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeImplementationProvider',
      uri,
      position
    );
    return (result ?? []).map((r) => this.toLocation(r));
  }

  async documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    if (!result) return [];
    if (Array.isArray(result) && result.length > 0 && 'children' in (result[0] as object)) {
      return result as vscode.DocumentSymbol[];
    }
    // Fall back: SymbolInformation -> DocumentSymbol-like wrappers
    return (result as vscode.SymbolInformation[]).map((s) => ({
      name: s.name,
      detail: s.containerName ?? '',
      kind: s.kind,
      range: s.location.range,
      selectionRange: s.location.range,
      children: [],
      tags: []
    }));
  }

  async workspaceSymbols(query: string): Promise<vscode.SymbolInformation[]> {
    const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query
    );
    return result ?? [];
  }

  async hover(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Hover[]> {
    const result = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position
    );
    return result ?? [];
  }

  async codeActions(uri: vscode.Uri, range: vscode.Range): Promise<vscode.CodeAction[]> {
    const result = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      'vscode.executeCodeActionProvider',
      uri,
      range
    );
    if (!result) return [];
    return result.filter((r): r is vscode.CodeAction => 'edit' in r || 'command' in r) as vscode.CodeAction[];
  }

  /** Wait until at least one provider is registered for the language. */
  async waitForLanguage(languageId: string): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < this.maxWaitMs) {
      const langs = await vscode.languages.getLanguages();
      if (langs.includes(languageId)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private toLocation(r: vscode.Location | vscode.LocationLink): vscode.Location {
    if ('targetUri' in r) {
      return new vscode.Location(r.targetUri, r.targetRange ?? r.targetSelectionRange);
    }
    return r;
  }
}
