import * as vscode from 'vscode';

/**
 * Virtual document provider that holds an immutable snapshot of a file's
 * ORIGINAL (pre-edit) contents for use as the "before" side of the diff
 * editor.
 *
 * Since propose_edit now writes the modified content directly to disk —
 * so users can compile/run with the changes before accepting — the live
 * file on disk is the "after" view. We register the FROZEN original here
 * so the diff editor can show `(original  ↔  live file)` and the user can
 * still see what the file looked like before the agent touched it.
 *
 * Despite the historical method name `registerProposed`, the content
 * stored is now the original, not the proposal. The `.proposed` URI
 * suffix is kept to avoid breaking the scheme/path detection that other
 * parts of HunkApplier rely on.
 */
export class DiffPreview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'burstcode-preview';

  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** key = uri.toString() (the burstcode-preview URI) -> frozen original contents */
  private readonly snapshots = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DiffPreview.scheme, this);
  }

  /**
   * Register the FROZEN original snapshot for a source URI. The returned
   * URI is opaque to callers; it's used as the left-hand side of the diff
   * editor. Subsequent calls with the same source URI replace the snapshot
   * (rare — we normally take one snapshot per propose_edit cycle).
   */
  registerProposed(sourceUri: vscode.Uri, originalContent: string): vscode.Uri {
    const proposedUri = sourceUri.with({
      scheme: DiffPreview.scheme,
      path: sourceUri.path + '.proposed'
    });
    this.snapshots.set(proposedUri.toString(), originalContent);
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
