import * as vscode from 'vscode';
import { readChatProfile, readBackgroundProfile } from '../llm/OpenAIClient';
import type { ExplorerStatus } from '../background/BackgroundExplorer';

type NodeKind = 'group' | 'leaf';

class BasicNode extends vscode.TreeItem {
  children?: BasicNode[];

  constructor(
    kind: NodeKind,
    label: string,
    options: {
      description?: string;
      tooltip?: string;
      icon?: string;
      command?: vscode.Command;
      contextValue?: string;
      expanded?: boolean;
    } = {}
  ) {
    const collapsible =
      kind === 'group'
        ? options.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    super(label, collapsible);
    this.description = options.description;
    this.tooltip = options.tooltip ?? (options.description ? `${label} — ${options.description}` : label);
    if (options.icon) this.iconPath = new vscode.ThemeIcon(options.icon);
    this.command = options.command;
    this.contextValue = options.contextValue;
  }
}

function formatPhase(phase: string, enabled: boolean): string {
  if (!enabled) return 'off';
  switch (phase) {
    case 'idle-waiting': return 'idle';
    case 'running': return 'running…';
    case 'paused-by-chat': return 'paused (chat)';
    case 'paused-by-activity': return 'paused';
    case 'no-workspace': return 'no folder';
    case 'disabled': return 'off';
    case 'error': return 'error';
    default: return phase;
  }
}

function permissionsSummary(shellEnabled: boolean, shellAuto: boolean): string {
  if (!shellEnabled) return 'shell off';
  return shellAuto ? 'shell + auto-approve' : 'shell on';
}

export class BasicInfoView implements vscode.TreeDataProvider<BasicNode>, vscode.Disposable {
  static readonly viewType = 'burstcode.basicInfoView';

  private readonly emitter = new vscode.EventEmitter<BasicNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<BasicNode | undefined> = this.emitter.event;
  private readonly configSub: vscode.Disposable;
  private backgroundStatus?: ExplorerStatus;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('burstcode.llm') ||
        e.affectsConfiguration('burstcode.background') ||
        e.affectsConfiguration('burstcode.shell')
      ) {
        this.refresh();
      }
    });
  }

  setBackgroundStatus(status: ExplorerStatus): void {
    this.backgroundStatus = status;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: BasicNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BasicNode): BasicNode[] {
    if (element) return element.children ?? [];
    return this.buildRoot();
  }

  private buildRoot(): BasicNode[] {
    const chatProfile = readChatProfile();
    const chatModel = chatProfile.model || chatProfile.models[0] || '';
    const bgProfile = readBackgroundProfile();
    const bg = vscode.workspace.getConfiguration('burstcode.background');
    const shell = vscode.workspace.getConfiguration('burstcode.shell');

    const bgEnabled = bg.get<boolean>('enabled') ?? false;
    const bgRunTests = bg.get<boolean>('runGeneratedTests') ?? false;
    const bgOutputDir = (bg.get<string>('outputDir') ?? '.burstcode').trim() || '.burstcode';

    const shellEnabled = shell.get<boolean>('enabled') ?? true;
    const shellAuto = shell.get<boolean>('autoApprove') ?? false;

    const status = this.backgroundStatus;
    const phaseLabel = formatPhase(status?.phase ?? 'unknown', bgEnabled);
    const version = String(this.context.extension.packageJSON?.version ?? '');

    const chatPair = chatModel || '';
    const bgPair = bgProfile.inherit
      ? 'inherit chat'
      : bgProfile.model || bgProfile.models[0] || 'inherit chat';

    // ---------- Models ----------
    const modelsGroup = new BasicNode('group', 'Models', {
      description: chatPair || 'not configured',
      icon: 'server-process',
      expanded: true
    });
    modelsGroup.children = [
      new BasicNode('leaf', 'Chat', {
        description: chatPair || 'pick one',
        icon: chatModel ? 'comment-discussion' : 'warning',
        tooltip: chatModel
          ? `Chat model: ${chatPair}\nbaseURL: ${chatProfile.baseURL || '(unset)'}\nClick to switch.`
          : 'No active chat model — click to pick one.',
        command: { command: 'burstcode.selectModel', title: 'Select Chat Model' }
      }),
      new BasicNode('leaf', 'Background', {
        description: bgPair,
        icon: bgProfile.inherit ? 'arrow-swap' : 'circuit-board',
        tooltip: bgProfile.inherit
          ? 'Background loop inherits the chat profile.\nClick to override.'
          : `Background model: ${bgPair}\nClick to change or inherit chat.`,
        command: {
          command: 'burstcode.background.selectModel',
          title: 'Select Background Model'
        }
      }),
      new BasicNode('leaf', 'Chat profile settings…', {
        description: 'baseURL / apiKey / model',
        icon: 'globe',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Chat Profile Settings',
          arguments: ['burstcode.llm.chat']
        }
      }),
      new BasicNode('leaf', 'Background profile settings…', {
        description: 'inherit / baseURL / apiKey / model',
        icon: 'globe',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Background Profile Settings',
          arguments: ['burstcode.llm.background']
        }
      })
    ];

    // ---------- Permissions ----------
    const permissions = new BasicNode('group', 'Permissions', {
      description: permissionsSummary(shellEnabled, shellAuto),
      icon: 'shield',
      expanded: true
    });
    permissions.children = [
      this.toggleNode(
        'Shell commands',
        shellEnabled,
        'burstcode.shell.enabled',
        'Allow the agent to run shell commands via the run_shell tool.',
        'terminal'
      ),
      this.toggleNode(
        'Auto-approve shell',
        shellAuto,
        'burstcode.shell.autoApprove',
        'Skip the per-command approval prompt. Leave OFF unless you trust the model fully.',
        shellAuto ? 'unlock' : 'lock'
      )
    ];

    // ---------- Background Explorer (behaviour only — no model here) ----------
    const bgGroup = new BasicNode('group', 'Background Explorer', {
      description: phaseLabel,
      tooltip: status?.detail || 'Idle-time codebase analyser',
      icon: 'pulse',
      expanded: bgEnabled
    });
    bgGroup.children = [
      this.toggleNode(
        bgEnabled ? 'Enabled' : 'Disabled',
        bgEnabled,
        'burstcode.background.enabled',
        'Idle-time codebase analyser. Runs while you are not editing.',
        bgEnabled ? 'play-circle' : 'stop-circle'
      ),
      this.toggleNode(
        'Auto-run generated tests',
        bgRunTests,
        'burstcode.background.runGeneratedTests',
        'Run vitest/jest/pytest on the unit tests the explorer generates.',
        bgRunTests ? 'beaker' : 'circle-slash'
      ),
      new BasicNode('leaf', `Output folder: ${bgOutputDir}`, {
        icon: 'folder',
        tooltip: 'Workspace-relative directory used for docs/, bugs.md, tests/, state.json',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Output Directory',
          arguments: ['burstcode.background.outputDir']
        }
      }),
      new BasicNode('leaf', 'Schedule…', {
        description: 'idle / interval / files per cycle',
        icon: 'clock',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Background Schedule',
          arguments: ['burstcode.background']
        }
      })
    ];

    // ---------- Actions ----------
    const actions = new BasicNode('group', 'Actions', { icon: 'rocket' });
    actions.children = [
      new BasicNode('leaf', 'Open chat', {
        icon: 'comment-discussion',
        command: { command: 'burstcode.openChat', title: 'Open Chat' }
      }),
      new BasicNode('leaf', 'New chat', {
        icon: 'add',
        command: { command: 'burstcode.newChat', title: 'New Chat' }
      }),
      new BasicNode('leaf', 'Run background analysis now', {
        icon: 'play',
        command: { command: 'burstcode.background.runOnce', title: 'Run Once' }
      }),
      new BasicNode('leaf', 'Show background activity log', {
        icon: 'output',
        command: { command: 'burstcode.background.showActivityLog', title: 'Show Log' }
      }),
      new BasicNode('leaf', 'Restore Git checkpoint…', {
        icon: 'history',
        command: { command: 'burstcode.restoreCheckpoint', title: 'Restore Checkpoint' }
      })
    ];

    // ---------- Footer ----------
    const advanced = new BasicNode('leaf', 'All settings…', {
      description: 'Full BurstCode configuration',
      icon: 'settings-gear',
      command: {
        command: 'workbench.action.openSettings',
        title: 'Open Settings',
        arguments: ['burstcode']
      }
    });
    const about = new BasicNode('leaf', `BurstCode v${version}`, {
      description: 'About',
      icon: 'info'
    });

    return [modelsGroup, permissions, bgGroup, actions, advanced, about];
  }

  private toggleNode(
    label: string,
    value: boolean,
    key: string,
    description: string,
    icon: string
  ): BasicNode {
    return new BasicNode('leaf', label, {
      description: value ? 'on' : 'off',
      icon,
      tooltip: `${description}\nClick to toggle (${key}).`,
      command: {
        command: 'burstcode.toggleSetting',
        title: `Toggle ${key}`,
        arguments: [key]
      }
    });
  }

  dispose(): void {
    this.configSub.dispose();
    this.emitter.dispose();
  }
}
