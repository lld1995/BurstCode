import * as vscode from 'vscode';
import { Logger } from '../util/Logger';

interface LanguagePack {
  /** documentSelector languageIds (lowercased) */
  languageIds: string[];
  /** file extensions (without dot) used as fallback when languageId is not yet resolved */
  extensions: string[];
  /** required extension ids on the marketplace */
  required: string[];
  /** optional but recommended */
  recommended?: string[];
  /** human readable label */
  label: string;
}

const PACKS: LanguagePack[] = [
  {
    label: 'C# / .NET',
    languageIds: ['csharp'],
    extensions: ['cs'],
    required: ['ms-dotnettools.csdevkit']
  },
  {
    label: 'Python',
    languageIds: ['python'],
    extensions: ['py'],
    required: ['ms-python.python', 'ms-python.vscode-pylance']
  },
  {
    label: 'Avalonia XAML',
    languageIds: ['xml', 'axaml'],
    extensions: ['axaml'],
    required: ['AvaloniaTeam.vscode-avalonia']
  },
  {
    label: 'WPF/UWP XAML',
    languageIds: ['xml', 'xaml'],
    extensions: ['xaml'],
    required: ['ms-dotnettools.csdevkit']
  },
  {
    label: 'JavaScript / TypeScript',
    languageIds: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    extensions: ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
    required: [],
    recommended: ['dbaeumer.vscode-eslint']
  },
  {
    label: 'Vue',
    languageIds: ['vue'],
    extensions: ['vue'],
    required: ['Vue.volar']
  },
  {
    label: 'CSS / SCSS / Less',
    languageIds: ['css', 'scss', 'less'],
    extensions: ['css', 'scss', 'less'],
    required: [],
    recommended: ['bradlc.vscode-tailwindcss', 'ecmel.vscode-html-css']
  },
  {
    label: 'HTML',
    languageIds: ['html'],
    extensions: ['html', 'htm'],
    required: []
  }
];

export class DependencyGuard implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly notified = new Set<string>();

  constructor(private readonly logger: Logger) {}

  startWatching(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.checkDocument(doc)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.checkDocument(editor.document);
        }
      })
    );
    if (vscode.window.activeTextEditor) {
      this.checkDocument(vscode.window.activeTextEditor.document);
    }
  }

  /** Public API for agent tools — returns true when all required extensions are active. */
  async ensureForLanguage(languageId: string): Promise<{ ok: boolean; missing: string[]; pack?: LanguagePack }> {
    const pack = this.findPackByLanguage(languageId);
    if (!pack) return { ok: true, missing: [] };
    const missing = pack.required.filter((id) => !this.isInstalled(id));
    return { ok: missing.length === 0, missing, pack };
  }

  private checkDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') return;
    const pack = this.findPackByLanguage(doc.languageId) ?? this.findPackByPath(doc.uri.fsPath);
    if (!pack) return;
    const missing = pack.required.filter((id) => !this.isInstalled(id));
    if (missing.length === 0) return;
    const key = pack.label;
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.promptInstall(pack, missing).catch((err) => this.logger.error('promptInstall failed', String(err)));
  }

  private findPackByLanguage(languageId: string): LanguagePack | undefined {
    return PACKS.find((p) => p.languageIds.includes(languageId.toLowerCase()));
  }

  private findPackByPath(fsPath: string): LanguagePack | undefined {
    const ext = fsPath.split('.').pop()?.toLowerCase();
    if (!ext) return undefined;
    return PACKS.find((p) => p.extensions.includes(ext));
  }

  private isInstalled(extensionId: string): boolean {
    return !!vscode.extensions.getExtension(extensionId);
  }

  private async promptInstall(pack: LanguagePack, missing: string[]): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      `BurstCode 需要 ${pack.label} 的依赖插件：${missing.join(', ')}。安装后可获得静态分析能力。`,
      'Install',
      'Open in Marketplace',
      'Skip'
    );
    if (action === 'Install') {
      for (const id of missing) {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
      }
    } else if (action === 'Open in Marketplace') {
      for (const id of missing) {
        await vscode.commands.executeCommand('workbench.extensions.search', `@id:${id}`);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
