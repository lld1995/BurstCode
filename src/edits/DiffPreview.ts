import * as vscode from 'vscode';

/** Virtual document provider for the "before" snapshot used in diff editor. */
export class DiffPreview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'burstcode-preview';

  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** key = uri.toString() (the burstcode-preview URI) -> file contents */
  private readonly snapshots = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DiffPreview.scheme, this);
  }

  /** Register an "after" virtual URI for a given source URI and content. */
  registerProposed(sourceUri: vscode.Uri, modifiedContent: string): vscode.Uri {
    const proposedUri = sourceUri.with({
      scheme: DiffPreview.scheme,
      path: sourceUri.path + '.proposed'
    });
    this.snapshots.set(proposedUri.toString(), modifiedContent);
    this.emitter.fire(proposedUri);
    return proposedUri;
  }

  unregister(uri: vscode.Uri): void {
    this.snapshots.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.emitter.dispose();
    this.registration.dispose();
  }
}
