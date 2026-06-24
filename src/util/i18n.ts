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
  'models.imageProfile': 'Image profile settings…',
  'models.imageProfile.desc': 'baseURL / apiKey / model / size',

  // Permissions group
  'perm.group': 'Permissions',
  'perm.shellOff': 'shell off',
  'perm.shellOn': 'shell on',
  'perm.shellAuto': 'shell + auto-approve',
  'perm.shellCommands': 'Shell commands',
  'perm.shellCommands.tip': 'Allow the agent to run shell commands via the run_shell tool.',
  'perm.autoApprove': 'Auto-approve shell',
  'perm.autoApprove.tip': 'Skip the per-command approval prompt. Leave OFF unless you trust the model fully.',

  // Web tools group
  'web.group': 'Web tools',
  'web.proxy': 'Proxy',
  'web.proxy.configured': 'configured',
  'web.proxy.fallback': 'VS Code/env fallback',
  'web.proxy.tipConfigured': 'web_search/read_webpage use proxy: {0}\nClick to configure.',
  'web.proxy.tipEmpty': 'No BurstCode web proxy configured. Falls back to VS Code http.proxy, then HTTPS_PROXY/HTTP_PROXY. Click to configure.',
  'web.brave.on': 'Brave enabled',
  'web.brave.off': 'Brave not configured',
  'web.braveKey': 'Brave Search API key',
  'web.braveKey.tip': 'Set a Brave Search API key. web_search tries Brave before DuckDuckGo/Bing when configured.',
  'web.braveTest': 'Test Brave Search',
  'web.braveTest.ready': 'ready',
  'web.braveTest.needKey': 'set API key first',
  'web.braveTest.tip': 'Send a small Brave Search request to verify the API key and proxy settings.',
  'web.configured': 'configured',
  'web.notConfigured': 'not configured',

  // MCP group
  'mcp.group': 'MCP',
  'mcp.configured': '{0} enabled',
  'mcp.notConfigured': 'not configured',
  'mcp.servers': 'MCP servers…',
  'mcp.servers.desc': '{0} configured',
  'mcp.servers.empty': 'click to configure',
  'mcp.servers.tip': 'Configure burstcode.mcp.servers. Stdio servers use command/args/env/cwd; remote servers use url/headers.',
  'mcp.tools': 'Enabled MCP tools…',
  'mcp.tools.all': 'all discovered tools',
  'mcp.tools.selected': '{0} selected',
  'mcp.tools.tip': 'Open a picker from this left panel to list discovered tools from all configured MCP servers and choose which ones are enabled for agent runs. Empty selection means all discovered tools are enabled.',

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
  'actions.globalRules': 'Global rules',
  'actions.globalRules.tip': 'Open .burstcode/rules.md. Its contents are injected into every agent run in this workspace.',
  'actions.globalSkills': 'Global skills',
  'actions.globalSkills.tip': 'Open .burstcode/skills/. Create one skill per Markdown file; BurstCode injects only skills matching the current task.',
  'actions.showLog': 'Show background activity log',
  'actions.restoreCheckpoint': 'Restore Git checkpoint…',

  // Footer
  'footer.allSettings': 'All settings…',
  'footer.allSettings.desc': 'Full BurstCode configuration',
  'footer.about': 'About',

  // Interface
  'ui.group': 'Interface',
  'ui.taskDoneSound': 'Task completion sound',
  'ui.taskDoneSound.on': 'completion sound on',
  'ui.taskDoneSound.off': 'completion sound off',
  'ui.taskDoneSound.tip': 'Play a bright ascending chime when an agent task completes. It repeats until you click, type, focus the window, or otherwise interact with BurstCode/VS Code.',
  'ui.askUserSound': 'Ask-user prompt sound',
  'ui.askUserSound.on': 'ask prompt sound on',
  'ui.askUserSound.off': 'ask prompt sound off',
  'ui.askUserSound.tip': 'Play a softer repeated attention tone while BurstCode is waiting for your answer to an ask_user prompt.',

  // Language
  'lang.label': 'Language',
  'lang.desc': 'Side panel language',
  'lang.tip': 'Current UI language: {0}\nClick to switch.',
  'lang.zh': '简体中文',
  'lang.en': 'English',
  'lang.auto': 'Auto (follow VS Code)',
  'lang.pick': 'Select side panel language',

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
  'models.imageProfile': '图片配置…',
  'models.imageProfile.desc': 'baseURL / apiKey / 模型 / 尺寸',

  // Permissions group
  'perm.group': '权限',
  'perm.shellOff': '终端已关闭',
  'perm.shellOn': '终端已开启',
  'perm.shellAuto': '终端 + 自动批准',
  'perm.shellCommands': '终端命令',
  'perm.shellCommands.tip': '允许智能体通过 run_shell 工具执行终端命令。',
  'perm.autoApprove': '自动批准终端',
  'perm.autoApprove.tip': '跳过每条命令的批准提示。除非完全信任模型，否则请保持关闭。',

  // Web tools group
  'web.group': '联网工具',
  'web.proxy': '代理',
  'web.proxy.configured': '已配置',
  'web.proxy.fallback': '使用 VS Code/环境变量',
  'web.proxy.tipConfigured': 'web_search/read_webpage 使用代理：{0}\n点击配置。',
  'web.proxy.tipEmpty': '未配置 BurstCode 联网代理。会回退到 VS Code http.proxy，然后回退到 HTTPS_PROXY/HTTP_PROXY。点击配置。',
  'web.brave.on': 'Brave 已启用',
  'web.brave.off': 'Brave 未配置',
  'web.braveKey': 'Brave 搜索 API Key',
  'web.braveKey.tip': '设置 Brave Search API Key。配置后 web_search 会优先使用 Brave，再回退到 DuckDuckGo/Bing。',
  'web.braveTest': '测试 Brave 搜索',
  'web.braveTest.ready': '可测试',
  'web.braveTest.needKey': '请先设置 API Key',
  'web.braveTest.tip': '发送一次小的 Brave Search 请求，验证 API Key 和代理设置是否可用。',
  'web.configured': '已配置',
  'web.notConfigured': '未配置',

  // MCP group
  'mcp.group': 'MCP 配置',
  'mcp.configured': '已启用 {0} 个',
  'mcp.notConfigured': '未配置',
  'mcp.servers': 'MCP 服务器…',
  'mcp.servers.desc': '已配置 {0} 个',
  'mcp.servers.empty': '点击配置',
  'mcp.servers.tip': '配置 burstcode.mcp.servers。stdio 服务使用 command/args/env/cwd；远程服务使用 url/headers。',
  'mcp.tools': '启用的 MCP 工具…',
  'mcp.tools.all': '使用全部发现的工具',
  'mcp.tools.selected': '已指定 {0} 个',
  'mcp.tools.tip': '从左侧面板打开选择器，列出所有已配置 MCP 服务器发现到的工具，并选择哪些工具允许在 agent 运行中使用。未指定时表示启用全部发现的工具。',

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
  'actions.globalRules': '全局规则',
  'actions.globalRules.tip': '打开 .burstcode/rules.md。该文件内容会注入此工作区的每次 agent 执行。',
  'actions.globalSkills': '全局技能',
  'actions.globalSkills.tip': '打开 .burstcode/skills/。每个 Markdown 文件对应一个 skill；BurstCode 只注入匹配当前任务的 skill。',
  'actions.showLog': '查看后台活动日志',
  'actions.restoreCheckpoint': '恢复 Git 检查点…',

  // Footer
  'footer.allSettings': '全部设置…',
  'footer.allSettings.desc': '完整的 BurstCode 配置',
  'footer.about': '关于',

  // Interface
  'ui.group': '界面',
  'ui.taskDoneSound': '任务完成声音提醒',
  'ui.taskDoneSound.on': '完成声音已开启',
  'ui.taskDoneSound.off': '完成声音已关闭',
  'ui.taskDoneSound.tip': 'Agent 任务完成后播放明亮的上行提示音。只要你点击、输入、聚焦窗口，或在 BurstCode/VS Code 中有交互，就会停止提醒。',
  'ui.askUserSound': '询问用户声音提醒',
  'ui.askUserSound.on': '询问提示音已开启',
  'ui.askUserSound.off': '询问提示音已关闭',
  'ui.askUserSound.tip': 'BurstCode 等待你回答 ask_user 提问时，播放较柔和的重复注意提示音。',

  // Language
  'lang.label': '语言',
  'lang.desc': '侧边面板语言',
  'lang.tip': '当前界面语言：{0}\n点击切换。',
  'lang.zh': '简体中文',
  'lang.en': 'English',
  'lang.auto': '自动（跟随 VS Code）',
  'lang.pick': '选择侧边面板语言',

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
