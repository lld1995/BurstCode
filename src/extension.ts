import * as vscode from 'vscode';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { BasicInfoView } from './chat/BasicInfoView';
import { DependencyGuard } from './deps/DependencyGuard';
import { HunkApplier } from './edits/HunkApplier';
import { DiffPreview } from './edits/DiffPreview';
import { GitCheckpoint } from './git/GitCheckpoint';
import { Logger } from './util/Logger';
import { testBraveSearchApi } from './agent/tools/web';
import {
  readChatProfile,
  readBackgroundProfile,
  addChatModel,
  updateBackgroundProfile,
  addBackgroundModel,
  fetchProfileModels,
  writeCachedFetchedModels
} from './llm/OpenAIClient';
import {
  openGlobalRulesFile,
  openGlobalSkillsDirectory
} from './memory/GlobalRules';
import { WorkspaceIndex } from './context/WorkspaceIndex';
import { BackgroundExplorer, ExplorerStatus } from './background/BackgroundExplorer';
import { t, UI_LANGUAGE_CONFIG_KEY } from './util/i18n';
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

  const basicInfoView = new BasicInfoView(context);
  context.subscriptions.push(
    basicInfoView,
    vscode.window.registerTreeDataProvider(BasicInfoView.viewType, basicInfoView)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('burstcode.openChat', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.burstcode-chat');
      } catch {
        await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
      }
      try {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
      } catch {
        await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
      }
    }),
    vscode.commands.registerCommand('burstcode.newChat', () => chatProvider.newChat()),
    vscode.commands.registerCommand('burstcode.configureModel', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'burstcode.llm')
    ),
    vscode.commands.registerCommand('burstcode.toggleSetting', async (key?: string) => {
      if (!key || typeof key !== 'string') return;
      const dot = key.lastIndexOf('.');
      if (dot <= 0) return;
      const section = key.slice(0, dot);
      const prop = key.slice(dot + 1);
      const cfg = vscode.workspace.getConfiguration(section);
      // Flip the value at the scope that is CURRENTLY winning so the merged
      // (effective) value actually changes. Writing blindly to Global would
      // be silently overridden whenever a workspace / folder setting pins
      // the same key (e.g. `.vscode/settings.json`), which is exactly how
      // toggles like `burstcode.shell.autoApprove` end up stuck "on" in the
      // UI while the agent keeps prompting.
      const inspected = cfg.inspect<boolean>(prop);
      const current = cfg.get<boolean>(prop) ?? false;
      const next = !current;
      let target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global;
      if (inspected?.workspaceFolderValue !== undefined) {
        target = vscode.ConfigurationTarget.WorkspaceFolder;
      } else if (inspected?.workspaceValue !== undefined) {
        target = vscode.ConfigurationTarget.Workspace;
      }
      try {
        await cfg.update(prop, next, target);
      } catch (err) {
        // WorkspaceFolder can fail when no folder is open; fall back to Global.
        if (target !== vscode.ConfigurationTarget.Global) {
          await cfg.update(prop, next, vscode.ConfigurationTarget.Global);
          target = vscode.ConfigurationTarget.Global;
        } else {
          throw err;
        }
      }
      vscode.window.setStatusBarMessage(
        `BurstCode: ${key} = ${next ? 'on' : 'off'}`,
        2000
      );
    }),
    vscode.commands.registerCommand('burstcode.selectLanguage', async () => {
      const cfg = vscode.workspace.getConfiguration('burstcode.ui');
      const current = cfg.get<string>('language', 'zh');
      type LangItem = vscode.QuickPickItem & { value: 'zh' | 'en' | 'auto' };
      const items: LangItem[] = [
        { label: t('lang.zh'), value: 'zh' as const },
        { label: t('lang.en'), value: 'en' as const },
        { label: t('lang.auto'), value: 'auto' as const }
      ].map((it) => ({
        ...it,
        description: it.value === current ? '\u2713' : undefined
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: t('lang.pick'),
        placeHolder: t('lang.pick')
      });
      if (!picked || picked.value === current) return;
      // Update via the root configuration section using the fully-qualified key.
      // Updating through the intermediate `burstcode.ui` node can fail with
      // "... is not a registered configuration" on some VS Code builds.
      const rootCfg = vscode.workspace.getConfiguration();
      const inspected = rootCfg.inspect<string>(UI_LANGUAGE_CONFIG_KEY);
      let target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global;
      if (inspected?.workspaceFolderValue !== undefined) {
        target = vscode.ConfigurationTarget.WorkspaceFolder;
      } else if (inspected?.workspaceValue !== undefined) {
        target = vscode.ConfigurationTarget.Workspace;
      }
      try {
        await rootCfg.update(UI_LANGUAGE_CONFIG_KEY, picked.value, target);
      } catch (err) {
        if (target !== vscode.ConfigurationTarget.Global) {
          await rootCfg.update(UI_LANGUAGE_CONFIG_KEY, picked.value, vscode.ConfigurationTarget.Global);
        } else {
          throw err;
        }
      }
    }),
    vscode.commands.registerCommand('burstcode.web.testBrave', async () => {
      const key = (vscode.workspace.getConfiguration('burstcode.web').get<string>('braveApiKey') ?? '').trim();
      if (!key) {
        const action = await vscode.window.showWarningMessage(
          'BurstCode: Brave Search API key is not configured.',
          'Open Settings'
        );
        if (action === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'burstcode.web.braveApiKey');
        }
        return;
      }

      try {
        const results = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'BurstCode: testing Brave Search…' },
          () => testBraveSearchApi('BurstCode')
        );
        const first = results[0];
        vscode.window.showInformationMessage(
          `BurstCode: Brave Search OK — ${results.length} result(s). First: ${first.title}`
        );
      } catch (err) {
        const detail = String((err as Error).message ?? err).trim() || 'unknown error';
        const message = `BurstCode: Brave Search test failed — ${detail}`;
        const action = await vscode.window.showErrorMessage(
          message,
          { modal: true },
          'Open Settings',
          'Copy Details'
        );
        if (action === 'Open Settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'burstcode.web.braveApiKey');
        } else if (action === 'Copy Details') {
          await vscode.env.clipboard.writeText(message);
        }
      }
    }),
    vscode.commands.registerCommand('burstcode.selectModel', async () => {
      const chat = readChatProfile();
      type Item = vscode.QuickPickItem & { action?: 'pick' | 'fetch' | 'add'; model?: string };
      const items: Item[] = [];
      if (chat.models.length > 0) {
        items.push({
          label: 'Stored models',
          kind: vscode.QuickPickItemKind.Separator
        });
        for (const m of chat.models) {
          items.push({
            label: m,
            description: m === chat.model ? '(active)' : '',
            detail: chat.baseURL,
            action: 'pick',
            model: m
          });
        }
      }
      items.push({
        label: '$(cloud-download) Fetch models from /v1/models',
        description: chat.baseURL || '(set baseURL first)',
        action: 'fetch'
      });
      items.push({
        label: '$(add) Add custom model id…',
        action: 'add'
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'BurstCode: Select Chat Model',
        placeHolder: 'Pick a stored model, fetch from /v1/models, or add manually'
      });
      if (!picked) return;
      if (picked.action === 'fetch') {
        if (!chat.baseURL) {
          vscode.window.showWarningMessage('BurstCode: set burstcode.llm.chat.baseURL before fetching models.');
          return;
        }
        try {
          const ids = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching models from ${chat.baseURL}…` },
            () =>
              fetchProfileModels({
                baseURL: chat.baseURL,
                apiKey: chat.apiKey,
                allowSelfSignedCerts: chat.allowSelfSignedCerts
              })
          );
          // Mirror into the shared cache so the chat-panel picker shows
          // these immediately (without re-hitting /v1/models).
          await writeCachedFetchedModels(context.globalState, chat.baseURL, ids);
          if (ids.length === 0) {
            vscode.window.showWarningMessage(`BurstCode: ${chat.baseURL} returned no models.`);
            return;
          }
          const idStrings = ids.map((e) => e.id);
          const sub = await vscode.window.showQuickPick(idStrings, {
            title: 'BurstCode: Models on chat baseURL',
            placeHolder: 'Pick a model to activate'
          });
          if (sub) {
            await chatProvider.selectChatModel(sub);
            vscode.window.showInformationMessage(`BurstCode: chat model set to "${sub}".`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`BurstCode: failed to fetch models — ${String((err as Error).message ?? err)}`);
        }
      } else if (picked.action === 'add') {
        const id = await vscode.window.showInputBox({
          title: 'BurstCode: Add chat model id',
          placeHolder: 'e.g. qwen2.5-coder:7b'
        });
        const trimmed = id?.trim();
        if (trimmed) {
          await addChatModel(trimmed);
          await chatProvider.selectChatModel(trimmed);
          vscode.window.showInformationMessage(`BurstCode: chat model set to "${trimmed}".`);
        }
      } else if (picked.action === 'pick' && picked.model) {
        await chatProvider.selectChatModel(picked.model);
        vscode.window.showInformationMessage(`BurstCode: chat model set to "${picked.model}".`);
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
  basicInfoView.setBackgroundStatus(backgroundExplorer.getStatus());
  context.subscriptions.push(
    backgroundExplorer.onDidChangeStatus((s: ExplorerStatus) => {
      chatProvider.setBackgroundStatus(s);
      basicInfoView.setBackgroundStatus(s);
    }),
    chatProvider.onDidForegroundActivity((reason) => backgroundExplorer.notifyForegroundActivity(reason))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('burstcode.openGlobalRules', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('BurstCode: open a workspace folder first.');
        return;
      }
      try {
        await openGlobalRulesFile(root);
      } catch (err) {
        vscode.window.showErrorMessage(`BurstCode: failed to open global rules — ${String((err as Error).message ?? err)}`);
      }
    }),
    vscode.commands.registerCommand('burstcode.openGlobalSkills', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('BurstCode: open a workspace folder first.');
        return;
      }
      try {
        await openGlobalSkillsDirectory(root);
      } catch (err) {
        vscode.window.showErrorMessage(`BurstCode: failed to open global skills folder — ${String((err as Error).message ?? err)}`);
      }
    })
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
      const profile = readBackgroundProfile();
      const modelLabel = profile.inherit
        ? '(inherit chat)'
        : profile.model || profile.models[0] || '(chat default)';
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
          description: modelLabel
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
      const profile = readBackgroundProfile();
      const chat = readChatProfile();
      type Item = vscode.QuickPickItem & { action?: 'inherit' | 'pick' | 'fetch' | 'add'; model?: string };
      const items: Item[] = [
        {
          label: '$(arrow-swap) Inherit from chat',
          description: profile.inherit
            ? '(active) Reuse the chat profile'
            : 'Reuse the chat profile',
          action: 'inherit'
        }
      ];
      if (profile.models.length > 0) {
        items.push({
          label: 'Background-only stored models',
          kind: vscode.QuickPickItemKind.Separator
        });
        for (const m of profile.models) {
          items.push({
            label: m,
            description:
              !profile.inherit && m === profile.model ? '(active)' : '',
            detail: profile.baseURL || `(inherit ${chat.baseURL})`,
            action: 'pick',
            model: m
          });
        }
      }
      const probeBaseURL = profile.baseURL || chat.baseURL;
      items.push({
        label: '$(cloud-download) Fetch models from /v1/models',
        description: probeBaseURL || '(set baseURL first)',
        action: 'fetch'
      });
      items.push({
        label: '$(add) Add custom background model id…',
        action: 'add'
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'BurstCode: Background Explorer Model',
        placeHolder: 'Pick a model for the background loop, or inherit from chat'
      });
      if (!picked) return;
      if (picked.action === 'inherit') {
        await updateBackgroundProfile({ inherit: true });
        vscode.window.showInformationMessage('BurstCode: background explorer will inherit the chat model.');
        return;
      }
      if (picked.action === 'fetch') {
        if (!probeBaseURL) {
          vscode.window.showWarningMessage('BurstCode: set a baseURL on the background or chat profile before fetching.');
          return;
        }
        try {
          const ids = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching models from ${probeBaseURL}…` },
            () =>
              fetchProfileModels({
                baseURL: probeBaseURL,
                apiKey: profile.apiKey || chat.apiKey,
                allowSelfSignedCerts: profile.allowSelfSignedCerts || chat.allowSelfSignedCerts
              })
          );
          // Mirror into the shared cache so the chat-panel picker stays in
          // sync if the background profile shares its baseURL.
          await writeCachedFetchedModels(context.globalState, probeBaseURL, ids);
          if (ids.length === 0) {
            vscode.window.showWarningMessage(`BurstCode: ${probeBaseURL} returned no models.`);
            return;
          }
          const idStrings = ids.map((e) => e.id);
          const sub = await vscode.window.showQuickPick(idStrings, {
            title: 'BurstCode: Models on background baseURL',
            placeHolder: 'Pick a model for the background explorer'
          });
          if (sub) {
            await updateBackgroundProfile({ inherit: false, model: sub });
            vscode.window.showInformationMessage(`BurstCode: background explorer using "${sub}".`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`BurstCode: failed to fetch models — ${String((err as Error).message ?? err)}`);
        }
      } else if (picked.action === 'add') {
        const id = await vscode.window.showInputBox({
          title: 'BurstCode: Add background model id',
          placeHolder: 'e.g. qwen2.5-coder:7b'
        });
        const trimmed = id?.trim();
        if (trimmed) {
          await addBackgroundModel(trimmed);
          await updateBackgroundProfile({ inherit: false, model: trimmed });
          vscode.window.showInformationMessage(`BurstCode: background explorer using "${trimmed}".`);
        }
      } else if (picked.action === 'pick' && picked.model) {
        await updateBackgroundProfile({ inherit: false, model: picked.model });
        vscode.window.showInformationMessage(`BurstCode: background explorer using "${picked.model}".`);
      }
    })
  );

  logger.info('BurstCode activated.');
}

export function deactivate(): void {
  // disposables handled via context.subscriptions
}

// (Legacy settings migration intentionally removed — the new flat
// `burstcode.llm.chat.*` / `burstcode.llm.background.*` keys are the only
// supported schema.)
