import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { DependencyGuard } from './deps/DependencyGuard';
import { HunkApplier } from './edits/HunkApplier';
import { DiffPreview } from './edits/DiffPreview';
import { GitCheckpoint } from './git/GitCheckpoint';
import { Logger } from './util/Logger';
import {
  readEndpoints,
  fetchEndpointModels,
  setActiveSelection,
  getActiveEndpointName,
  getActiveModelName
} from './llm/OpenAIClient';
import { WorkspaceIndex } from './context/WorkspaceIndex';
import { BackgroundExplorer, ExplorerStatus } from './background/BackgroundExplorer';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  context.subscriptions.push(logger);

  logger.info('BurstCode activating...');

  const dependencyGuard = new DependencyGuard(logger);
  context.subscriptions.push(dependencyGuard);
  dependencyGuard.startWatching();

  // Pre-analyse the workspace once on activation so the first chat turn
  // doesn't pay for a fresh disk walk. The index keeps itself fresh by
  // listening to file create/delete/rename events.
  const workspaceIndex = new WorkspaceIndex(logger);
  context.subscriptions.push(workspaceIndex);
  workspaceIndex.prewarm();

  const diffPreview = new DiffPreview();
  context.subscriptions.push(diffPreview);

  const gitCheckpoint = new GitCheckpoint(logger);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => gitCheckpoint.invalidate())
  );

  const hunkApplier = new HunkApplier(diffPreview, logger, gitCheckpoint);
  context.subscriptions.push(hunkApplier);

  const chatProvider = new ChatViewProvider(
    context,
    logger,
    dependencyGuard,
    hunkApplier,
    gitCheckpoint,
    workspaceIndex
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('burstcode.newChat', () => chatProvider.newChat()),
    vscode.commands.registerCommand('burstcode.configureModel', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'burstcode.llm')
    ),
    vscode.commands.registerCommand('burstcode.selectModel', async () => {
      const endpoints = readEndpoints();
      type Item = vscode.QuickPickItem & { endpoint: string; model: string };
      const activeEp = getActiveEndpointName();
      const activeModel = getActiveModelName();
      const items: Item[] = [];
      for (const ep of endpoints) {
        items.push({
          label: ep.name,
          kind: vscode.QuickPickItemKind.Separator,
          endpoint: ep.name,
          model: ''
        });
        for (const m of ep.models) {
          items.push({
            label: m,
            description: ep.name === activeEp && m === activeModel ? '(active)' : '',
            detail: ep.baseURL,
            endpoint: ep.name,
            model: m
          });
        }
        items.push({
          label: '$(cloud-download) Fetch models from this endpoint',
          description: ep.baseURL,
          endpoint: ep.name,
          model: '__fetch__'
        });
        items.push({
          label: '$(add) Add custom model id...',
          endpoint: ep.name,
          model: '__add__'
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'BurstCode: Select Active Model',
        placeHolder: 'Pick a model, fetch from /v1/models, or add one manually'
      });
      if (!picked) return;
      if (picked.model === '__fetch__') {
        const ep = endpoints.find((e) => e.name === picked.endpoint);
        if (!ep) return;
        try {
          const ids = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching models from ${ep.name}...` },
            () => fetchEndpointModels(ep)
          );
          if (ids.length === 0) {
            vscode.window.showWarningMessage(`BurstCode: ${ep.name} returned no models.`);
            return;
          }
          const sub = await vscode.window.showQuickPick(ids, {
            title: `BurstCode: Models on ${ep.name}`,
            placeHolder: 'Pick a model to activate'
          });
          if (sub) {
            await setActiveSelection(ep.name, sub);
            vscode.window.showInformationMessage(`BurstCode: switched to "${ep.name} / ${sub}".`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`BurstCode: failed to fetch models — ${String((err as Error).message ?? err)}`);
        }
      } else if (picked.model === '__add__') {
        const id = await vscode.window.showInputBox({
          title: `BurstCode: Add model under ${picked.endpoint}`,
          placeHolder: 'e.g. qwen2.5-coder:7b'
        });
        if (id && id.trim()) {
          await setActiveSelection(picked.endpoint, id.trim());
          vscode.window.showInformationMessage(`BurstCode: switched to "${picked.endpoint} / ${id.trim()}".`);
        }
      } else if (picked.model) {
        await setActiveSelection(picked.endpoint, picked.model);
        vscode.window.showInformationMessage(`BurstCode: switched to "${picked.endpoint} / ${picked.model}".`);
      }
    }),
    vscode.commands.registerCommand('burstcode.restoreCheckpoint', () =>
      gitCheckpoint.restoreInteractive()
    ),
    vscode.commands.registerCommand('burstcode.acceptAllSuggestions', () => hunkApplier.acceptAll()),
    vscode.commands.registerCommand('burstcode.rejectAllSuggestions', () => hunkApplier.rejectAll()),
    vscode.commands.registerCommand('burstcode.acceptHunk', (id: string) => hunkApplier.acceptHunk(id)),
    vscode.commands.registerCommand('burstcode.rejectHunk', (id: string) => hunkApplier.rejectHunk(id))
  );

  // ---------------------------------------------------------------
  // Background code explorer (idle-time analyser).
  // ---------------------------------------------------------------
  const backgroundExplorer = new BackgroundExplorer(context, logger, chatProvider, workspaceIndex, hunkApplier);
  context.subscriptions.push(backgroundExplorer);

  // The explorer's live status is rendered as a pill inside the chat panel
  // (sibling of the context-usage gauge); we forward every transition to the
  // ChatViewProvider, which owns the webview.
  chatProvider.setBackgroundStatus(backgroundExplorer.getStatus());
  context.subscriptions.push(
    backgroundExplorer.onDidChangeStatus((s: ExplorerStatus) => chatProvider.setBackgroundStatus(s)),
    chatProvider.onDidForegroundActivity((reason) => backgroundExplorer.notifyForegroundActivity(reason))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('burstcode.background.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('burstcode.background');
      const next = !(cfg.get<boolean>('enabled') ?? false);
      await cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `BurstCode background explorer ${next ? 'enabled' : 'disabled'}.`
      );
    }),
    vscode.commands.registerCommand('burstcode.background.runOnce', () =>
      backgroundExplorer.runOnce()
    ),
    vscode.commands.registerCommand('burstcode.background.resetState', () =>
      backgroundExplorer.resetState()
    ),
    vscode.commands.registerCommand('burstcode.background.showActivityLog', () =>
      backgroundExplorer.showOutput()
    ),
    // Single-entry-point menu, fired by clicking the chat-panel pill.
    vscode.commands.registerCommand('burstcode.background.menu', async () => {
      const cfg = vscode.workspace.getConfiguration('burstcode.background');
      const isOn = cfg.get<boolean>('enabled') ?? false;
      const status = backgroundExplorer.getStatus();
      const epLabel = cfg.get<string>('endpoint') || '(inherit chat)';
      const modelLabel = cfg.get<string>('model') || '(endpoint default)';
      type Item = vscode.QuickPickItem & { id: string };
      const items: Item[] = [
        {
          id: 'log',
          label: '$(output) Open activity log',
          description: 'Reveal the "BurstCode Background" output channel'
        },
        {
          id: 'model',
          label: '$(circuit-board) Select background model\u2026',
          description: `${epLabel} \u00b7 ${modelLabel}`
        },
        {
          id: 'toggle',
          label: isOn ? '$(stop-circle) Disable background explorer' : '$(play-circle) Enable background explorer',
          description: `Currently: ${status.phase}`
        },
        {
          id: 'run',
          label: '$(play) Run analysis now',
          description: 'Force a single cycle, ignoring the idle gate'
        },
        {
          id: 'report',
          label: '$(file) Show report (README)',
          description: 'Open `.burstcode/README.md`'
        },
        {
          id: 'reset',
          label: '$(trash) Reset analysis state\u2026',
          description: 'Forget per-file hashes so everything is re-analysed'
        }
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `BurstCode background \u2014 ${status.phase}`,
        placeHolder: status.detail || 'Manage the background explorer'
      });
      if (!picked) return;
      switch (picked.id) {
        case 'log':
          await vscode.commands.executeCommand('burstcode.background.showActivityLog');
          break;
        case 'model':
          await vscode.commands.executeCommand('burstcode.background.selectModel');
          break;
        case 'toggle':
          await vscode.commands.executeCommand('burstcode.background.toggle');
          break;
        case 'run':
          await vscode.commands.executeCommand('burstcode.background.runOnce');
          break;
        case 'report':
          await vscode.commands.executeCommand('burstcode.background.showReport');
          break;
        case 'reset':
          await vscode.commands.executeCommand('burstcode.background.resetState');
          break;
      }
    }),
    vscode.commands.registerCommand('burstcode.background.showReport', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('BurstCode: open a workspace folder first.');
        return;
      }
      const outDir = vscode.workspace
        .getConfiguration('burstcode.background')
        .get<string>('outputDir') || '.burstcode';
      const readme = vscode.Uri.file(path.join(root, outDir, 'README.md'));
      try {
        const doc = await vscode.workspace.openTextDocument(readme);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showInformationMessage(
          'BurstCode: no background report yet — enable the explorer or run "Run Background Analysis Now".'
        );
      }
    }),
    vscode.commands.registerCommand('burstcode.background.selectModel', async () => {
      const endpoints = readEndpoints();
      type Item = vscode.QuickPickItem & { endpoint: string; model: string };
      const cfg = vscode.workspace.getConfiguration('burstcode.background');
      const currentEp = cfg.get<string>('endpoint') ?? '';
      const currentModel = cfg.get<string>('model') ?? '';
      const currentBaseURL = (cfg.get<string>('baseURL') ?? '').trim();
      const items: Item[] = [
        { label: '$(arrow-swap) Inherit from chat', description: 'Use whichever model the chat panel is on', endpoint: '', model: '' },
        {
          label: '$(globe) Custom base URL...',
          description: currentBaseURL
            ? `Currently: ${currentBaseURL}${currentModel ? ' · ' + currentModel : ''}`
            : 'Point background loop at a fully independent server',
          endpoint: '__custom_url__',
          model: ''
        }
      ];
      if (currentBaseURL) {
        items.push({
          label: '$(circle-slash) Clear custom URL',
          description: 'Stop using the custom baseURL and fall back to endpoint inheritance',
          endpoint: '__clear_url__',
          model: ''
        });
      }
      for (const ep of endpoints) {
        items.push({
          label: ep.name,
          kind: vscode.QuickPickItemKind.Separator,
          endpoint: ep.name,
          model: ''
        });
        for (const m of ep.models) {
          items.push({
            label: m,
            description: ep.name === currentEp && m === currentModel ? '(background active)' : '',
            detail: ep.baseURL,
            endpoint: ep.name,
            model: m
          });
        }
        items.push({
          label: '$(cloud-download) Fetch models from this endpoint',
          description: ep.baseURL,
          endpoint: ep.name,
          model: '__fetch__'
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'BurstCode: Background Explorer Model',
        placeHolder: 'Pick a model for the background loop (independent of chat)'
      });
      if (!picked) return;
      if (picked.endpoint === '__custom_url__') {
        const url = await vscode.window.showInputBox({
          title: 'BurstCode: Custom background base URL',
          prompt: 'OpenAI-compatible base URL for the background explorer (e.g. http://192.168.1.50:11434/v1)',
          value: currentBaseURL,
          ignoreFocusOut: true,
          validateInput: (v) => {
            const s = (v ?? '').trim();
            if (!s) return undefined; // empty = clear
            try { new URL(s); return undefined; } catch { return 'Not a valid URL.'; }
          }
        });
        if (url === undefined) return; // cancelled
        const trimmed = url.trim();
        if (!trimmed) {
          await cfg.update('baseURL', '', vscode.ConfigurationTarget.Global);
          await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('BurstCode: cleared background custom URL.');
          return;
        }
        const apiKey = await vscode.window.showInputBox({
          title: 'BurstCode: API key for background URL',
          prompt: 'Optional API key for the background server (leave empty for local servers like Ollama)',
          value: cfg.get<string>('apiKey') ?? '',
          ignoreFocusOut: true,
          password: true
        });
        if (apiKey === undefined) return; // cancelled mid-way
        const modelId = await vscode.window.showInputBox({
          title: 'BurstCode: Model id on the custom URL',
          prompt: 'Model id to call on the custom server (e.g. qwen2.5-coder:7b). Leave empty to inherit later.',
          value: cfg.get<string>('model') ?? '',
          ignoreFocusOut: true
        });
        if (modelId === undefined) return;
        await cfg.update('baseURL', trimmed, vscode.ConfigurationTarget.Global);
        await cfg.update('apiKey', apiKey.trim(), vscode.ConfigurationTarget.Global);
        await cfg.update('model', modelId.trim(), vscode.ConfigurationTarget.Global);
        // Clear endpoint name override so it doesn't fight the explicit URL.
        await cfg.update('endpoint', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `BurstCode: background explorer pointed at "${trimmed}"${modelId.trim() ? ' · ' + modelId.trim() : ''}.`
        );
        return;
      }
      if (picked.endpoint === '__clear_url__') {
        await cfg.update('baseURL', '', vscode.ConfigurationTarget.Global);
        await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('BurstCode: cleared background custom URL — falling back to endpoint inheritance.');
        return;
      }
      if (picked.model === '__fetch__') {
        const ep = endpoints.find((e) => e.name === picked.endpoint);
        if (!ep) return;
        try {
          const ids = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching models from ${ep.name}...` },
            () => fetchEndpointModels(ep)
          );
          if (ids.length === 0) {
            vscode.window.showWarningMessage(`BurstCode: ${ep.name} returned no models.`);
            return;
          }
          const sub = await vscode.window.showQuickPick(ids, {
            title: `BurstCode: Models on ${ep.name}`,
            placeHolder: 'Pick a model for the background explorer'
          });
          if (sub) {
            await cfg.update('endpoint', ep.name, vscode.ConfigurationTarget.Global);
            await cfg.update('model', sub, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`BurstCode: background explorer using "${ep.name} / ${sub}".`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`BurstCode: failed to fetch models — ${String((err as Error).message ?? err)}`);
        }
      } else {
        await cfg.update('endpoint', picked.endpoint, vscode.ConfigurationTarget.Global);
        await cfg.update('model', picked.model, vscode.ConfigurationTarget.Global);
        // Picking a named endpoint (or "Inherit from chat") supersedes any
        // previously-set custom baseURL — otherwise the override would win
        // silently and the user would be confused why their pick was ignored.
        if (currentBaseURL) {
          await cfg.update('baseURL', '', vscode.ConfigurationTarget.Global);
          await cfg.update('apiKey', '', vscode.ConfigurationTarget.Global);
        }
        if (picked.endpoint || picked.model) {
          vscode.window.showInformationMessage(
            `BurstCode: background explorer using "${picked.endpoint || '(chat endpoint)'} / ${picked.model || '(endpoint default)'}".`
          );
        } else {
          vscode.window.showInformationMessage('BurstCode: background explorer will inherit the chat model.');
        }
      }
    })
  );

  logger.info('BurstCode activated.');
}

export function deactivate(): void {
  // disposables handled via context.subscriptions
}
