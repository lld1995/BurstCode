import * as vscode from 'vscode';
import { readChatProfile, readBackgroundProfile } from '../llm/OpenAIClient';
import type { ExplorerStatus } from '../background/BackgroundExplorer';
import { t } from '../util/i18n';

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
  if (!enabled) return t('phase.off');
  switch (phase) {
    case 'idle-waiting': return t('phase.idle');
    case 'running': return t('phase.running');
    case 'paused-by-chat': return t('phase.pausedChat');
    case 'paused-by-activity': return t('phase.pausedActivity');
    case 'no-workspace': return t('phase.noWorkspace');
    case 'disabled': return t('phase.off');
    case 'error': return t('phase.error');
    default: return phase;
  }
}

function permissionsSummary(shellEnabled: boolean, shellAuto: boolean): string {
  if (!shellEnabled) return t('perm.shellOff');
  return shellAuto ? t('perm.shellAuto') : t('perm.shellOn');
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
        e.affectsConfiguration('burstcode.shell') ||
        e.affectsConfiguration('burstcode.ui') ||
        e.affectsConfiguration('burstcode.web') ||
        e.affectsConfiguration('burstcode.mcp') ||
        e.affectsConfiguration('http.proxy')
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
    const web = vscode.workspace.getConfiguration('burstcode.web');
    const mcp = vscode.workspace.getConfiguration('burstcode.mcp');
    const ui = vscode.workspace.getConfiguration('burstcode.ui');

    const bgEnabled = bg.get<boolean>('enabled') ?? false;
    const bgRunTests = bg.get<boolean>('runGeneratedTests') ?? false;
    const bgOutputDir = (bg.get<string>('outputDir') ?? '.burstcode').trim() || '.burstcode';

    const shellEnabled = shell.get<boolean>('enabled') ?? true;
    const shellAuto = shell.get<boolean>('autoApprove') ?? false;
    const taskDoneSound = ui.get<boolean>('taskDoneSound') ?? true;
    const askUserSound = ui.get<boolean>('askUserSound') ?? true;
    const proxyUrl = (web.get<string>('proxyUrl') ?? '').trim();
    const braveKey = (web.get<string>('braveApiKey') ?? '').trim();
    const mcpServers = (mcp.get<unknown[]>('servers') ?? []).filter((s) => !!s && typeof s === 'object') as Array<Record<string, unknown>>;
    const mcpEnabledCount = mcpServers.filter((s) => s.disabled !== true).length;
    const mcpSelectedTools = mcp.get<string[]>('enabledTools') ?? [];
    const mcpSelectedToolCount = mcpSelectedTools.filter((v) => typeof v === 'string' && v.trim()).length;
    const proxyDesc = proxyUrl ? t('web.proxy.configured') : t('web.proxy.fallback');

    const status = this.backgroundStatus;
    const phaseLabel = formatPhase(status?.phase ?? 'unknown', bgEnabled);
    const version = String(this.context.extension.packageJSON?.version ?? '');

    const chatPair = chatModel || '';
    const bgPair = bgProfile.inherit
      ? 'inherit chat'
      : bgProfile.model || bgProfile.models[0] || 'inherit chat';

    // ---------- Models ----------
    const modelsGroup = new BasicNode('group', t('models.group'), {
      description: chatPair || t('models.notConfigured'),
      icon: 'server-process',
      expanded: true
    });
    modelsGroup.children = [
      new BasicNode('leaf', t('models.chat'), {
        description: chatPair || t('models.chat.pickOne'),
        icon: chatModel ? 'comment-discussion' : 'warning',
        tooltip: chatModel
          ? t('models.chat.tooltip', chatPair, chatProfile.baseURL || '(unset)')
          : t('models.chat.tooltipEmpty'),
        command: { command: 'burstcode.selectModel', title: 'Select Chat Model' }
      }),
      new BasicNode('leaf', t('models.background'), {
        description: bgPair,
        icon: bgProfile.inherit ? 'arrow-swap' : 'circuit-board',
        tooltip: bgProfile.inherit
          ? t('models.background.tooltipInherit')
          : t('models.background.tooltip', bgPair),
        command: {
          command: 'burstcode.background.selectModel',
          title: 'Select Background Model'
        }
      }),
      new BasicNode('leaf', t('models.chatProfile'), {
        description: t('models.chatProfile.desc'),
        icon: 'globe',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Chat Profile Settings',
          arguments: ['burstcode.llm.chat']
        }
      }),
      new BasicNode('leaf', t('models.bgProfile'), {
        description: t('models.bgProfile.desc'),
        icon: 'globe',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Background Profile Settings',
          arguments: ['burstcode.llm.background']
        }
      }),
      new BasicNode('leaf', t('models.imageProfile'), {
        description: t('models.imageProfile.desc'),
        icon: 'file-media',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Image Profile Settings',
          arguments: ['burstcode.llm.image']
        }
      }),
      new BasicNode('leaf', t('models.videoProfile'), {
        description: t('models.videoProfile.desc'),
        icon: 'device-camera-video',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Open Video Profile Settings',
          arguments: ['burstcode.llm.video']
        }
      })
    ];

    // ---------- Permissions ----------
    const permissions = new BasicNode('group', t('perm.group'), {
      description: permissionsSummary(shellEnabled, shellAuto),
      icon: 'shield',
      expanded: true
    });
    permissions.children = [
      this.toggleNode(
        t('perm.shellCommands'),
        shellEnabled,
        'burstcode.shell.enabled',
        t('perm.shellCommands.tip'),
        'terminal'
      ),
      this.toggleNode(
        t('perm.autoApprove'),
        shellAuto,
        'burstcode.shell.autoApprove',
        t('perm.autoApprove.tip'),
        shellAuto ? 'unlock' : 'lock'
      )
    ];

    // ---------- Web tools ----------
    const webGroup = new BasicNode('group', t('web.group'), {
      description: braveKey ? t('web.brave.on') : t('web.brave.off'),
      icon: 'search',
      expanded: true
    });
    webGroup.children = [
      new BasicNode('leaf', t('web.proxy'), {
        description: proxyDesc,
        icon: proxyUrl ? 'plug' : 'globe',
        tooltip: proxyUrl ? t('web.proxy.tipConfigured', proxyUrl) : t('web.proxy.tipEmpty'),
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Web Proxy',
          arguments: ['burstcode.web.proxyUrl']
        }
      }),
      new BasicNode('leaf', t('web.braveKey'), {
        description: braveKey ? t('web.configured') : t('web.notConfigured'),
        icon: braveKey ? 'key' : 'warning',
        tooltip: t('web.braveKey.tip'),
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Brave Search API Key',
          arguments: ['burstcode.web.braveApiKey']
        }
      }),
      new BasicNode('leaf', t('web.braveTest'), {
        description: braveKey ? t('web.braveTest.ready') : t('web.braveTest.needKey'),
        icon: 'beaker',
        tooltip: t('web.braveTest.tip'),
        command: {
          command: 'burstcode.web.testBrave',
          title: 'Test Brave Search'
        }
      })
    ];

    // ---------- MCP ----------
    const mcpGroup = new BasicNode('group', t('mcp.group'), {
      description: mcpEnabledCount > 0 ? t('mcp.configured', mcpEnabledCount) : t('mcp.notConfigured'),
      icon: 'plug',
      expanded: true
    });
    mcpGroup.children = [
      new BasicNode('leaf', t('mcp.servers'), {
        description: mcpServers.length > 0 ? t('mcp.servers.desc', mcpServers.length) : t('mcp.servers.empty'),
        icon: mcpServers.length > 0 ? 'server-process' : 'warning',
        tooltip: t('mcp.servers.tip'),
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure MCP Servers',
          arguments: ['burstcode.mcp.servers']
        }
      }),
      new BasicNode('leaf', t('mcp.tools'), {
        description: mcpSelectedToolCount > 0 ? t('mcp.tools.selected', mcpSelectedToolCount) : t('mcp.tools.all'),
        icon: 'tools',
        tooltip: t('mcp.tools.tip'),
        command: {
          command: 'burstcode.mcp.selectTools',
          title: 'Select Enabled MCP Tools'
        }
      })
    ];

    // ---------- Background Explorer (behaviour only — no model here) ----------
    const bgGroup = new BasicNode('group', t('bg.group'), {
      description: phaseLabel,
      tooltip: status?.detail || t('bg.idleAnalyser'),
      icon: 'pulse',
      expanded: bgEnabled
    });
    bgGroup.children = [
      this.toggleNode(
        bgEnabled ? t('bg.enabled') : t('bg.disabled'),
        bgEnabled,
        'burstcode.background.enabled',
        t('bg.enabled.tip'),
        bgEnabled ? 'play-circle' : 'stop-circle'
      ),
      this.toggleNode(
        t('bg.autoRunTests'),
        bgRunTests,
        'burstcode.background.runGeneratedTests',
        t('bg.autoRunTests.tip'),
        bgRunTests ? 'beaker' : 'circle-slash'
      ),
      new BasicNode('leaf', t('bg.outputFolder', bgOutputDir), {
        icon: 'folder',
        tooltip: t('bg.outputFolder.tip'),
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Output Directory',
          arguments: ['burstcode.background.outputDir']
        }
      }),
      new BasicNode('leaf', t('bg.schedule'), {
        description: t('bg.schedule.desc'),
        icon: 'clock',
        command: {
          command: 'workbench.action.openSettings',
          title: 'Configure Background Schedule',
          arguments: ['burstcode.background']
        }
      })
    ];

    // ---------- Actions ----------
    const actions = new BasicNode('group', t('actions.group'), { icon: 'rocket' });
    actions.children = [
      new BasicNode('leaf', t('actions.openChat'), {
        icon: 'comment-discussion',
        command: { command: 'burstcode.openChat', title: 'Open Chat' }
      }),
      new BasicNode('leaf', t('actions.newChat'), {
        icon: 'add',
        command: { command: 'burstcode.newChat', title: 'New Chat' }
      }),
      new BasicNode('leaf', t('actions.runNow'), {
        icon: 'play',
        command: { command: 'burstcode.background.runOnce', title: 'Run Once' }
      }),
      new BasicNode('leaf', t('actions.globalRules'), {
        description: '.burstcode/rules.md',
        icon: 'law',
        tooltip: t('actions.globalRules.tip'),
        command: { command: 'burstcode.openGlobalRules', title: 'Open Global Rules' }
      }),
      new BasicNode('leaf', t('actions.globalSkills'), {
        description: '.burstcode/skills/',
        icon: 'tools',
        tooltip: t('actions.globalSkills.tip'),
        command: { command: 'burstcode.openGlobalSkills', title: 'Open Global Skills Folder' }
      }),
      new BasicNode('leaf', t('actions.showLog'), {
        icon: 'output',
        command: { command: 'burstcode.background.showActivityLog', title: 'Show Log' }
      }),
      new BasicNode('leaf', t('actions.restoreCheckpoint'), {
        icon: 'history',
        command: { command: 'burstcode.restoreCheckpoint', title: 'Restore Checkpoint' }
      })
    ];

    // ---------- Footer ----------
    const advanced = new BasicNode('leaf', t('footer.allSettings'), {
      description: t('footer.allSettings.desc'),
      icon: 'settings-gear',
      command: {
        command: 'workbench.action.openSettings',
        title: 'Open Settings',
        arguments: ['burstcode']
      }
    });

    // ---------- Interface ----------
    const uiLangSetting = ui.get<string>('language', 'zh');
    const langValueLabel =
      uiLangSetting === 'en'
        ? t('lang.en')
        : uiLangSetting === 'auto'
          ? t('lang.auto')
          : t('lang.zh');
    const uiGroup = new BasicNode('group', t('ui.group'), {
      description: [
        taskDoneSound ? t('ui.taskDoneSound.on') : t('ui.taskDoneSound.off'),
        askUserSound ? t('ui.askUserSound.on') : t('ui.askUserSound.off')
      ].join(' · '),
      icon: 'bell',
      expanded: true
    });
    uiGroup.children = [
      this.toggleNode(
        t('ui.taskDoneSound'),
        taskDoneSound,
        'burstcode.ui.taskDoneSound',
        t('ui.taskDoneSound.tip'),
        taskDoneSound ? 'bell' : 'bell-slash'
      ),
      this.toggleNode(
        t('ui.askUserSound'),
        askUserSound,
        'burstcode.ui.askUserSound',
        t('ui.askUserSound.tip'),
        askUserSound ? 'question' : 'bell-slash'
      ),
      new BasicNode('leaf', t('lang.label'), {
        description: langValueLabel,
        icon: 'globe',
        tooltip: t('lang.tip', langValueLabel),
        command: { command: 'burstcode.selectLanguage', title: 'Select Language' }
      })
    ];
    const about = new BasicNode('leaf', `BurstCode v${version}`, {
      description: t('footer.about'),
      icon: 'info'
    });

    return [modelsGroup, permissions, webGroup, mcpGroup, bgGroup, actions, uiGroup, advanced, about];
  }

  private toggleNode(
    label: string,
    value: boolean,
    key: string,
    description: string,
    icon: string
  ): BasicNode {
    return new BasicNode('leaf', label, {
      description: value ? t('state.on') : t('state.off'),
      icon,
      tooltip: t('toggle.tip', description, key),
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
