import * as vscode from 'vscode';

export type UiLang = 'zh' | 'en';

/**
 * Resolve the UI language for BurstCode panels (NOT the chat webview, which
 * stays English). Controlled by `burstcode.ui.language`:
 *   - 'zh'   → 简体中文 (default)
 *   - 'en'   → English
 *   - 'auto' → follow VS Code's display language (zh* → zh, otherwise en)
 */
export function getUiLang(): UiLang {
  const setting = vscode.workspace
    .getConfiguration('burstcode.ui')
    .get<string>('language', 'zh');

  if (setting === 'en') return 'en';
  if (setting === 'zh') return 'zh';

  // 'auto' → derive from VS Code display language.
  const display = (vscode.env.language || 'en').toLowerCase();
  return display.startsWith('zh') ? 'zh' : 'en';
}

/** Config key that, when changed, should trigger a panel refresh. */
export const UI_LANGUAGE_CONFIG_KEY = 'burstcode.ui.language';

type Dict = Record<string, string>;

const EN: Dict = {
  // Models group
  'models.group': 'Models',
  'models.notConfigured': 'not configured',
  'models.chat': 'Chat',
  'models.chat.pickOne': 'pick one',
  'models.chat.tooltip': 'Chat model: {0}\nbaseURL: {1}\nClick to switch.',
  'models.chat.tooltipEmpty': 'No active chat model — click to pick one.',
  'models.background': 'Background',
  'models.background.inherit': 'inherit chat',
  'models.background.tooltipInherit': 'Background loop inherits the chat profile.\nClick to override.',
  'models.background.tooltip': 'Background model: {0}\nClick to change or inherit chat.',
  'models.chatProfile': 'Chat profile settings…',
  'models.chatProfile.desc': 'baseURL / apiKey / model',
  'models.bgProfile': 'Background profile settings…',
  'models.bgProfile.desc': 'inherit / baseURL / apiKey / model',

  // Permissions group
  'perm.group': 'Permissions',
  'perm.shellOff': 'shell off',
  'perm.shellOn': 'shell on',
  'perm.shellAuto': 'shell + auto-approve',
  'perm.shellCommands': 'Shell commands',
  'perm.shellCommands.tip': 'Allow the agent to run shell commands via the run_shell tool.',
  'perm.autoApprove': 'Auto-approve shell',
  'perm.autoApprove.tip': 'Skip the per-command approval prompt. Leave OFF unless you trust the model fully.',

  // Background Explorer group
  'bg.group': 'Background Explorer',
  'bg.idleAnalyser': 'Idle-time codebase analyser',
  'bg.enabled': 'Enabled',
  'bg.disabled': 'Disabled',
  'bg.enabled.tip': 'Idle-time codebase analyser. Runs while you are not editing.',
  'bg.autoRunTests': 'Auto-run generated tests',
  'bg.autoRunTests.tip': 'Run vitest/jest/pytest on the unit tests the explorer generates.',
  'bg.outputFolder': 'Output folder: {0}',
  'bg.outputFolder.tip': 'Workspace-relative directory used for docs/, bugs.md, tests/, state.json',
  'bg.schedule': 'Schedule…',
  'bg.schedule.desc': 'idle / interval / files per cycle',

  // Actions group
  'actions.group': 'Actions',
  'actions.openChat': 'Open chat',
  'actions.newChat': 'New chat',
  'actions.runNow': 'Run background analysis now',
  'actions.showLog': 'Show background activity log',
  'actions.restoreCheckpoint': 'Restore Git checkpoint…',

  // Footer
  'footer.allSettings': 'All settings…',
  'footer.allSettings.desc': 'Full BurstCode configuration',
  'footer.about': 'About',

  // Toggle state
  'state.on': 'on',
  'state.off': 'off',
  'toggle.tip': '{0}\nClick to toggle ({1}).',

  // Phases
  'phase.off': 'off',
  'phase.idle': 'idle',
  'phase.running': 'running…',
  'phase.pausedChat': 'paused (chat)',
  'phase.pausedActivity': 'paused',
  'phase.noWorkspace': 'no folder',
  'phase.error': 'error'
};

const ZH: Dict = {
  // Models group
  'models.group': '模型',
  'models.notConfigured': '未配置',
  'models.chat': '聊天',
  'models.chat.pickOne': '请选择',
  'models.chat.tooltip': '聊天模型：{0}\nbaseURL：{1}\n点击切换。',
  'models.chat.tooltipEmpty': '尚未选择聊天模型 —— 点击选择。',
  'models.background': '后台',
  'models.background.inherit': '继承聊天',
  'models.background.tooltipInherit': '后台循环继承聊天配置。\n点击以单独设置。',
  'models.background.tooltip': '后台模型：{0}\n点击更改或改为继承聊天。',
  'models.chatProfile': '聊天配置…',
  'models.chatProfile.desc': 'baseURL / apiKey / 模型',
  'models.bgProfile': '后台配置…',
  'models.bgProfile.desc': '继承 / baseURL / apiKey / 模型',

  // Permissions group
  'perm.group': '权限',
  'perm.shellOff': '终端已关闭',
  'perm.shellOn': '终端已开启',
  'perm.shellAuto': '终端 + 自动批准',
  'perm.shellCommands': '终端命令',
  'perm.shellCommands.tip': '允许智能体通过 run_shell 工具执行终端命令。',
  'perm.autoApprove': '自动批准终端',
  'perm.autoApprove.tip': '跳过每条命令的批准提示。除非完全信任模型，否则请保持关闭。',

  // Background Explorer group
  'bg.group': '后台探索器',
  'bg.idleAnalyser': '空闲时的代码库分析器',
  'bg.enabled': '已启用',
  'bg.disabled': '已禁用',
  'bg.enabled.tip': '空闲时的代码库分析器。在你不编辑时运行。',
  'bg.autoRunTests': '自动运行生成的测试',
  'bg.autoRunTests.tip': '对探索器生成的单元测试运行 vitest/jest/pytest。',
  'bg.outputFolder': '输出目录：{0}',
  'bg.outputFolder.tip': '用于 docs/、bugs.md、tests/、state.json 的工作区相对目录',
  'bg.schedule': '调度设置…',
  'bg.schedule.desc': '空闲 / 间隔 / 每轮文件数',

  // Actions group
  'actions.group': '操作',
  'actions.openChat': '打开聊天',
  'actions.newChat': '新建聊天',
  'actions.runNow': '立即运行后台分析',
  'actions.showLog': '查看后台活动日志',
  'actions.restoreCheckpoint': '恢复 Git 检查点…',

  // Footer
  'footer.allSettings': '全部设置…',
  'footer.allSettings.desc': '完整的 BurstCode 配置',
  'footer.about': '关于',

  // Toggle state
  'state.on': '开',
  'state.off': '关',
  'toggle.tip': '{0}\n点击切换（{1}）。',

  // Phases
  'phase.off': '关闭',
  'phase.idle': '空闲',
  'phase.running': '运行中…',
  'phase.pausedChat': '已暂停（聊天）',
  'phase.pausedActivity': '已暂停',
  'phase.noWorkspace': '无工作区',
  'phase.error': '错误'
};

const TABLES: Record<UiLang, Dict> = { en: EN, zh: ZH };

/**
 * Translate a key for the current UI language, with positional `{0}`, `{1}` …
 * substitution. Falls back to English, then to the raw key.
 */
export function t(key: string, ...args: (string | number)[]): string {
  const lang = getUiLang();
  const template = TABLES[lang][key] ?? EN[key] ?? key;
  return template.replace(/\{(\d+)\}/g, (_m, i) => {
    const v = args[Number(i)];
    return v === undefined ? '' : String(v);
  });
}
