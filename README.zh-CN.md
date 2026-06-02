<div align="center">

<img src="media/readme/hero.svg" alt="BurstCode" width="120" height="120" />

# BurstCode

**面向 VS Code 的 Windsurf 风格自主编码 Agent —— 完全由你自己的本地 OpenAI 兼容大模型驱动。**

与你的代码库对话，让 Agent 跨文件读取、搜索、编辑、构建与测试 —— 全部运行在你自己掌控的端点上（Ollama、vLLM、LM Studio、llama.cpp，或任意兼容 `/v1` 的服务）。无需云端账号、无遥测、无按 token 计费。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![VS Code ^1.106](https://img.shields.io/badge/VS%20Code-%5E1.106-007ACC.svg) ![Local LLM](https://img.shields.io/badge/LLM-local%20%2F%20OpenAI--compatible-success.svg)

[English](README.md) · **简体中文**

</div>

---

## 目录

- [为什么选择 BurstCode](#为什么选择-burstcode)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置你的大模型](#配置你的大模型)
- [使用方法](#使用方法)
- [Agent 工具箱](#agent-工具箱)
- [后台代码探索器](#后台代码探索器)
- [命令](#命令)
- [配置项参考](#配置项参考)
- [从源码构建](#从源码构建)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 为什么选择 BurstCode

大多数 Agent 类编码插件都默认你会把代码发送到托管的前沿模型。BurstCode 的设计前提恰恰相反：**模型运行在你本地。** 把它指向任意 OpenAI 兼容的 `/v1` 端点，它就会像一个完整的自主 Agent 一样工作 —— 规划多步任务、批量调用工具、以“先审查再回滚”的 diff 流程编辑文件、运行你的构建与测试，甚至在你工作时于后台探索代码库。

- **100% 本地优先** —— 除非*你*把端点指向远程服务器，否则你的源码不会离开本机。
- **自带模型** —— Qwen-Coder、DeepSeek-Coder、Llama、Codestral……凡是你的服务在 `/v1/models` 暴露的都可用。
- **两套独立配置档** —— 聊天用快/大的模型，后台用更便宜的模型。
- **理解 LSP** —— 它使用语言服务（跳转定义、查引用、查实现、悬停类型）而非盲目的文本搜索，因此重构能理解作用域与再导出。

---

## 功能特性

| | |
|---|---|
| 🧠 **自主 Agent 循环** | 规划、并行批量调用工具、卡住时自我纠正，并能跨越 token 上限/流中断边界自动续跑。 |
| ✏️ **先审查的编辑** | 每次改动都会立即落盘*并*以可审查的 diff 暂存，支持逐块 Accept / Reject。 |
| 🔁 **Git 检查点** | 每个 Agent 回合都会创建还原点；可在聊天中将整个工作区回滚。 |
| 🔍 **语义代码导航** | 跳转定义、查引用、查实现、悬停类型、文档与工作区符号 —— 由你安装的语言服务驱动。 |
| ⚡ **批量上下文收集** | `collect_context` 在一次往返中并发执行读取 + grep + 目录列举 + 大纲。 |
| 🧵 **并发子 Agent** | 把隔离的探索/并行编辑下放给拥有独立上下文窗口的专注子 Agent。 |
| 🌐 **Web 工具** | 搜索网络并读取网页/PDF，引入文档与报错解决方案。 |
| 🖥️ **Shell 执行** | 运行构建、测试、lint 与脚本 —— 带审批门控（也可对可信工作流自动批准）。 |
| 🛰️ **后台代码探索器** | IDE 空闲时扫描代码，写出逐文件文档、疑似 Bug 日志与自动生成的测试。 |
| 📌 **长期记忆** | 记录你纠正中的经验与项目约定，并保存主题文档，下次免去重复读码。 |

---

## 环境要求

1. **VS Code** `^1.106.0`（或兼容的分支）。
2. **一个 OpenAI 兼容的大模型端点。** 任何暴露 `/v1/chat/completions`（最好同时有 `/v1/models`）的服务均可。常见选择：

   **Ollama**（最简单的本地方案）
   ```bash
   # 1. 安装 Ollama → https://ollama.com/download
   # 2. 拉取一个编码模型
   ollama pull qwen2.5-coder:7b
   # 3. 确保服务在运行（Ollama 在 /v1 暴露 OpenAI 兼容 API）
   ollama serve
   # 端点：http://localhost:11434/v1
   ```

   **vLLM**
   ```bash
   python -m vllm.entrypoints.openai.api_server \
     --model Qwen/Qwen2.5-Coder-7B-Instruct
   # 端点：http://localhost:8000/v1
   ```

   **LM Studio / llama.cpp / 任意 `/v1` 服务** —— 启动服务并记下它的 base URL。

> 💡 上下文窗口较大（32k+）且工具调用能力强的模型能带来好得多的 Agent 体验。`qwen2.5-coder` 与 `deepseek-coder-v2` 是不错的起点。

---

## 安装

### 通过 `.vsix` 安装（目前推荐）

```powershell
code --install-extension burstcode-0.1.66.vsix
```

或在 VS Code 中：打开 **扩展** 视图 → `…` 菜单 → **从 VSIX 安装…** → 选择 `.vsix` 文件。

### 自行构建 `.vsix`

```powershell
npm install
npm run package      # 用 esbuild 打包扩展
npm run vsix         # 生成 burstcode-<version>.vsix
```

然后用上面的命令安装生成的文件。

---

## 配置你的大模型

BurstCode 有**两套独立的配置档**，让聊天与后台任务能使用不同的模型：

- `burstcode.llm.chat.*` —— 交互式聊天 Agent 使用的模型。
- `burstcode.llm.background.*` —— 后台代码探索器使用的模型（或设 `burstcode.llm.background.inherit = true` 复用聊天配置档）。

最快的上手方式是产品内的选择器：

1. 打开 **BurstCode Chat** 面板（见 [使用方法](#使用方法)）。
2. 从命令面板（`Ctrl/Cmd+Shift+P`）运行 **`BurstCode: Configure Model`** 或 **`BurstCode: Select Active Model`**。
3. 输入你的 base URL（如 `http://localhost:11434/v1`）并选择模型。模型 id 会从 `/v1/models` 实时获取，并与你手动列出的合并。

或者直接编辑 `settings.json`：

```jsonc
{
  // ── 聊天配置档 ───────────────────────────
  "burstcode.llm.chat.baseURL": "http://localhost:11434/v1",
  "burstcode.llm.chat.apiKey": "",                 // 多数本地服务可留空
  "burstcode.llm.chat.model": "qwen2.5-coder:7b",
  "burstcode.llm.chat.temperature": 0.2,
  "burstcode.llm.chat.contextWindow": 131072,      // 你的模型支持的总 token 数
  "burstcode.llm.chat.models": [],                 // 在选择器中额外显示的模型 id

  // ── 后台配置档 ───────────────────────────
  "burstcode.llm.background.inherit": false,        // true = 复用聊天配置档
  "burstcode.llm.background.baseURL": "http://localhost:11434/v1",
  "burstcode.llm.background.model": "qwen2.5-coder:7b"
}
```

> 🔒 连接使用自签名证书的 HTTPS 端点？把 `burstcode.llm.chat.allowSelfSignedCerts`（和/或后台对应项）设为 `true`。

---

## 使用方法

### 打开聊天

BurstCode 出现在**两个位置**：

- 活动栏中的 **BurstCode** 视图容器（信息/快捷操作）。
- **辅助侧边栏** 中的 **BurstCode Chat** webview。

从命令面板运行 **`BurstCode: Open Chat`** 打开聊天面板，或点击编辑器标题栏/视图标题栏中的 BurstCode 图标。随时用 **`BurstCode: New Chat`** 开启新会话。

### 与 Agent 对话

用自然语言输入请求，例如：

> *“给登录表单加上输入校验，并写一个测试。”*
> *“为什么 `parseConfig` 在空文件上会抛异常？修一下。”*
> *“把 `fetchUser` 全部重命名为 `loadUser` 并更新所有调用点。”*

Agent 会：

1. **定位** —— 用语义工具和批量上下文收集找到相关代码。
2. **规划** —— 对非平凡任务给出实时计划。
3. **编辑** —— 改动立即落盘*并*以暂存 diff 呈现。
4. **验证** —— 在需要时运行你的构建/测试。

### 审查改动

每次编辑都以 diff 形式呈现，并带逐块的 **Accept** / **Reject** 控件：

- **Accept** 保留改动（它已在磁盘上）。
- **Reject** 把该块回滚到原始内容。
- 用 **`BurstCode: Accept All Pending Suggestions`** / **`Reject All Pending Suggestions`** 一次性处理全部。

你无需等待 Agent —— 它会在你异步审查的同时继续工作。

### 回滚整个回合

BurstCode 在每个 Agent 回合前会做一个 **Git 检查点**。若某回合方向错了，可在聊天 UI 中或通过 **`BurstCode: Restore Git Checkpoint`** 还原 —— 工作区会回到该回合之前的状态。

---

## Agent 工具箱

Agent 会推理*哪个*工具最合适，并把相互独立的调用合并到一次往返。工具分为四类：

**上下文与搜索**
- `collect_context` —— 一次调用批量读取 + grep + 目录列举 + 大纲
- `read_file`、`list_dir`、`grep_search`、`workspace_outline`

**语义（LSP 驱动）**
- `find_definition`、`find_references` / `find_references_by_name`、`find_implementations`
- `document_symbols`、`workspace_symbols`、`hover_info`、`get_function_range`

**编辑与流程控制**
- `propose_edit`（先审查的代码块）、`write_file`（临时文件/脚本）
- `update_plan`、`ask_user`
- `record_lesson` / `forget_lesson`、`save_topic_doc`、`compress_context`

**执行与 Web**
- `run_shell`（构建/测试/lint，带审批门控）
- `launch_subagent`（并发的隔离读/写 Agent）
- `web_search`、`read_webpage`

---

## 后台代码探索器

一个可选、完全本地的后台工作器。当 IDE **空闲** —— 没有正在进行的聊天且近期无编辑 —— 它会挑选源文件、读取它们，并把分析结果写入工作区输出目录（默认 `.burstcode/`）。当你打字或聊天请求运行时它会自动暂停。

它会产出：

- **`docs/`** —— 每个文件做什么的逐文件白话摘要。
- **`bugs.md`** —— 疑似 Bug 与风险点的日志。
- **`tests/`** —— 针对不确定点自动生成的单元测试。
- **`verifications.md`** ——（可选）若启用测试执行，记录通过/失败结果。

用 **`BurstCode: Toggle Background Code Explorer`** 启用，或设 `burstcode.background.enabled = true`。用 **`BurstCode: Run Background Analysis Now`** 按需运行单个周期，并通过 **`Show Background Explorer Report`** / **`Show Background Explorer Activity Log`** 或统一的 **`Background Explorer Menu`** 查看输出。

> ⚠️ `burstcode.background.runGeneratedTests` **默认关闭** —— 运行自动生成的代码会触及你的 shell 与依赖。在不可信项目上启用前请先审查生成的测试。

---

## 命令

所有命令均可从命令面板（`Ctrl/Cmd+Shift+P`）调用。

| 命令 | 说明 |
|---|---|
| `BurstCode: Open Chat` | 打开聊天面板 |
| `BurstCode: New Chat` | 开启新会话 |
| `BurstCode: Configure Model` | 交互式设置 base URL / API key / 模型 |
| `BurstCode: Select Active Model` | 选择当前聊天模型 |
| `BurstCode: Accept All Pending Suggestions` | 接受所有待处理编辑 |
| `BurstCode: Reject All Pending Suggestions` | 拒绝所有待处理编辑 |
| `BurstCode: Accept Hunk` / `Reject Hunk` | 逐块决策 |
| `BurstCode: Restore Git Checkpoint` | 将工作区回滚到某回合的检查点 |
| `BurstCode: Toggle Background Code Explorer` | 启用/禁用后台工作器 |
| `BurstCode: Run Background Analysis Now` | 立即运行一个后台周期 |
| `BurstCode: Select Background Explorer Model` | 选择后台模型 |
| `BurstCode: Show Background Explorer Report` | 查看最新分析输出 |
| `BurstCode: Show Background Explorer Activity Log` | 查看后台活动日志 |
| `BurstCode: Reset Background Explorer State` | 清除后台进度/状态 |
| `BurstCode: Background Explorer Menu` | 上述功能的快捷菜单 |

---

## 配置项参考

### 大模型配置档

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `burstcode.llm.chat.baseURL` | `http://localhost:11434/v1` | 聊天端点 base URL |
| `burstcode.llm.chat.apiKey` | `""` | API key（本地服务可留空） |
| `burstcode.llm.chat.model` | `qwen2.5-coder:7b` | 当前聊天模型 id |
| `burstcode.llm.chat.temperature` | `0.2` | 采样温度 |
| `burstcode.llm.chat.contextWindow` | `131072` | 总上下文窗口（token） |
| `burstcode.llm.chat.allowSelfSignedCerts` | `false` | 跳过 base URL 的 TLS 校验 |
| `burstcode.llm.chat.models` | `[]` | 选择器中额外显示的模型 id |
| `burstcode.llm.background.inherit` | `false` | 后台任务复用聊天配置档 |
| `burstcode.llm.background.*` | — | 与聊天配置档相同的键 |

### Agent 循环

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `burstcode.agent.maxIterations` | `512` | 每个请求的最大工具调用迭代数 |
| `burstcode.agent.requireConfirmBeforeEdit` | `true` | 编辑在确认前先暂存审查 |
| `burstcode.agent.autoContinueOnLength` | `true` | 模型触达输出 token 上限时自动续跑 |
| `burstcode.agent.maxAutoContinues` | `2` | 最大连续自动续跑次数 |
| `burstcode.agent.autoResumeOnStreamError` | `true` | 流瞬时错误后重试该回合 |
| `burstcode.agent.maxAutoResumes` | `2` | 最大连续自动恢复次数 |
| `burstcode.agent.maxStuckRepeats` | `2` | 升级为交互提示前的相同回合重复数 |
| `burstcode.agent.autoContinueOnPrematureStop` | `true` | 模型无答案过早停止时继续 |
| `burstcode.agent.maxPrematureStopContinues` | `2` | 过早停止后的最大续跑次数 |
| `burstcode.agent.subagentMaxIterations` | `64` | 每个子 Agent 的最大迭代数 |
| `burstcode.agent.maxConcurrentSubagents` | `4` | 每个请求最大并发子 Agent 数 |
| `burstcode.agent.maxSubagentTasksPerCall` | `8` | 单次 `launch_subagent` 的最大任务数 |
| `burstcode.agent.enableWriteSubagents` | `true` | 允许子 Agent 在限定文件内编辑 |

### Shell

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `burstcode.shell.enabled` | `true` | 允许 `run_shell` 工具 |
| `burstcode.shell.autoApprove` | `false` | 跳过逐命令审批（请谨慎使用） |
| `burstcode.shell.defaultTimeoutMs` | `60000` | 默认命令超时 |

### 后台探索器

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `burstcode.background.enabled` | `false` | 启用后台工作器 |
| `burstcode.background.idleThresholdMs` | `10000` | 周期开始前的空闲间隔 |
| `burstcode.background.minIntervalMs` | `30000` | 周期之间的最小间隔 |
| `burstcode.background.batchCharBudget` | `120000` | 每个全量扫描批次的软字符上限 |
| `burstcode.background.batchMaxFiles` | `25` | 每批次硬性文件上限 |
| `burstcode.background.maxConcurrentTopics` | `10` | 每周期并行调查主题数 |
| `burstcode.background.includeExtensions` | （多种） | 探索器可读取的文件扩展名 |
| `burstcode.background.maxFileBytes` | `120000` | 跳过大于此值的文件 |
| `burstcode.background.outputDir` | `.burstcode` | 写入 docs/bugs/tests/state 的位置 |
| `burstcode.background.perFileTimeoutMs` | `300000` | 单次后台 LLM 调用基础超时（批次为 4×） |
| `burstcode.background.runGeneratedTests` | `false` | 执行生成的测试（会触及你的 shell） |
| `burstcode.background.testRunTimeoutMs` | `60000` | 单个测试执行超时 |

### 上下文与其它

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `burstcode.lsp.maxWaitMs` | `60000` | 等待语言服务就绪的最长时间 |
| `burstcode.ripgrepPath` | `""` | `rg` 二进制的显式路径（留空则自动探测） |
| `burstcode.context.outlineBaseDepth` | `2` | 系统提示中工作区大纲的递归深度 |
| `burstcode.context.outlineSrcDepth` | `4` | 对源码类目录的更深递归 |
| `burstcode.context.outlineMaxBytes` | `6000` | 嵌入的工作区大纲软上限 |
| `burstcode.context.outlineExtraExcludes` | `[]` | 大纲中额外排除的目录名 |

---

## 从源码构建

```powershell
npm install          # 安装依赖
npm run package      # 用 esbuild 打包 → dist/extension.js
npm run vsix         # 生成可安装的 .vsix
```

仅类型检查（不产物）：

```powershell
npx tsc --noEmit
```

迭代调试：在 VS Code 中按 **F5** 启动加载了 BurstCode 的扩展开发宿主。

---

## 常见问题

**Agent 连不上我的模型。**
确认 base URL 以 `/v1` 结尾且服务在运行（`curl http://localhost:11434/v1/models`）。自签名 HTTPS 请启用 `allowSelfSignedCerts`。

**`grep_search` 报 `spawn rg ENOENT`。**
把 `burstcode.ripgrepPath` 设为 `rg` / `rg.exe` 二进制的完整路径，然后重载窗口。

**模型中途停止或陷入循环。**
Agent 会自动续跑并自我纠正，但小模型难以应对很长的工具链。尝试更大/更强工具调用能力的模型，并确保 `contextWindow` 与你服务的真实上限一致。

**后台探索器从不运行。**
它仅在 IDE 空闲时运行。确认 `burstcode.background.enabled` 为 `true`、当前无聊天运行、且空闲已超过 `idleThresholdMs`。可用 **`Run Background Analysis Now`** 强制运行一个周期。

---

## 许可证

基于 [MIT 许可证](LICENSE) 发布。