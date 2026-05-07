<div align="center">

[English](README.md) · **简体中文**

</div>

<div align="center">

<img src="media/readme/hero.svg" alt="BurstCode" width="120" height="120" />

# BurstCode

*A local-first AI coding companion for VS Code.*

由你自己的本地模型驱动 · 代码不出本机 · 兼容任何 OpenAI 协议端点

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-1f1f1f?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/MIT-1f1f1f.svg)](LICENSE)
[![Local First](https://img.shields.io/badge/Local%20First-1f1f1f)](#)
[![Ollama](https://img.shields.io/badge/Ollama-1f1f1f)](https://ollama.com)
[![LM Studio](https://img.shields.io/badge/LM%20Studio-1f1f1f)](https://lmstudio.ai)
[![vLLM](https://img.shields.io/badge/vLLM-1f1f1f)](https://github.com/vllm-project/vllm)

</div>

<br />

<div align="center">

BurstCode 只做两件事，并把它们做到极致。

</div>

<br />

<table width="100%">
<tr>
<td width="50%" valign="top">

### ① &nbsp; AI Coding

主动、对话式的编程伙伴。
聊一句需求，它**自己规划、自己写、卡住会问你、被你纠正后会记住**。

→ [详细使用与配置](#ai-coding)

</td>
<td width="50%" valign="top">

### ② &nbsp; Background Intelligence

后台静默工作。键盘空闲时自动阅读你的工程，
产出文档、生成测试、标记疑似 Bug。

→ [详细使用与配置](#background-intelligence)

</td>
</tr>
</table>

---

# 安装与首次配置

## 第 1 步 · 跑一个本地模型

BurstCode 不附带模型，挑一个 OpenAI 协议兼容的服务跑起来即可。

<details open>
<summary><b>方式 A：Ollama（最省事，推荐新手）</b></summary>

```bash
# 1. 装 Ollama → https://ollama.com/download
# 2. 拉一个编程模型
ollama pull qwen2.5-coder:7b      # 7B，16GB 内存够用
# 或：
ollama pull qwen2.5-coder:14b     # 14B，效果更好，要 32GB

# 3. 启动服务（默认监听 http://localhost:11434）
ollama serve
```

</details>

<details>
<summary><b>方式 B：LM Studio（图形界面，零命令行）</b></summary>

1. 装 LM Studio → https://lmstudio.ai
2. 在 *Discover* 页搜一个编程模型下载（如 `Qwen2.5-Coder-7B-Instruct-GGUF`）
3. 切到 *Local Server* 页 → **Start Server**
4. 默认端点：`http://localhost:1234/v1`

</details>

<details>
<summary><b>方式 C：vLLM（生产级，需要 GPU）</b></summary>

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-7B-Instruct \
  --served-model-name qwen2.5-coder \
  --port 8000
# 端点：http://localhost:8000/v1
```

</details>

> 任何说 `/v1/chat/completions` 协议的服务都行：llama.cpp、TGI、OpenRouter、Azure OpenAI、自建网关……

## 第 2 步 · 安装扩展

```powershell
code --install-extension burstcode-0.1.3.vsix
```

或者在仓库根目录自己打一份：

```powershell
npm install
npm run package
npm run vsix          # 产出 burstcode-0.1.3.vsix
```

装好后 VS Code 活动栏会多出一个 ⚡ 图标。

## 第 3 步 · 注册端点

打开 VS Code 设置（`Ctrl+,`），搜 `burstcode.llm.endpoints`，点 *Edit in settings.json*。

### 极简版（推荐）—— 只填端点，模型让它自己拉

只要你的服务支持 `/v1/models`（Ollama / LM Studio / vLLM / OpenRouter 都支持），
连模型清单都不用写：

```jsonc
"burstcode.llm.endpoints": [
  {
    "name": "Local Ollama",
    "baseURL": "http://localhost:11434/v1",
    "apiKey": "ollama"
  }
]
```

保存后：

- **方式 1（Chat 面板内）**：点底部的模型选择器 → 端点旁的 ↻ **Refresh** 按钮 →
  在线拉取该端点的所有模型 → 点一个即激活
- **方式 2（命令面板）**：`Ctrl+Shift+P` → **`BurstCode: Select Active Model`** →
  选 *☁ Fetch models from this endpoint* → 选一个

不想联网拉？也可以选 *➕ Add custom model id...* 手动填一个 id（如 `qwen2.5-coder:7b`）。

### 完整版 —— 预填模型清单 + 多端点

如果你希望把常用模型预先列好，或要管理多个端点：

```jsonc
"burstcode.llm.endpoints": [
  {
    "name": "Local Ollama",
    "baseURL": "http://localhost:11434/v1",
    "apiKey": "ollama",
    "models": ["qwen2.5-coder:7b", "qwen2.5-coder:14b"],
    "contextWindow": 32768
  },
  {
    "name": "Office vLLM",
    "baseURL": "https://llm.intra/v1",
    "apiKey": "${INTRA_KEY}",
    "contextWindow": 65536,
    "allowSelfSignedCerts": true
  }
]
```

模型选择器会按端点分组，每个端点都能随时点 ↻ Refresh 在线刷新清单。完成 ✅。

## 第 4 步 · 打开 Chat，试一句

点活动栏 ⚡ 图标 → *BurstCode Chat* → 输入框：

> *"读一下 `src/extension.ts`，画一张组件依赖图给我。"*

如果它开始读文件、列大纲、回你一段架构说明，配置就成功了。

## 第 5 步（可选）· 打开后台静默分析

后台代码探索器**默认是关的** —— 装完不会偷偷跑模型。
想让它在你不打字的时候帮你**读代码、找 bug、生成测试、写文档**，三选一打开：

```jsonc
// settings.json
"burstcode.background.enabled": true
```

或者命令面板：`BurstCode: Toggle Background Code Explorer`
或者 Chat 面板右下角点状态药丸 → *Enable Background Explorer*。

> 💡 强烈建议给后台**单独配一个更小、更便宜的模型**（省电省显存）——
> 详见 [② Background Intelligence](#background-intelligence) 的"**三种配法**"。

<br />

## 接下来：选一个深入读

<table width="100%">
<tr>
<td width="50%" valign="top" align="center">

### → [① AI Coding 详解](#ai-coding)

基本用法 · 自动 Plan · 阻塞提问 · 自我进化
命令速查 · 关键配置项

</td>
<td width="50%" valign="top" align="center">

### → [② Background Intelligence 详解](#background-intelligence)

启用与禁用 · 端点 / 模型独立配置（3 种模式）
内部机制 · 完整配置项

</td>
</tr>
</table>

<br />

---

<br />

<a id="ai-coding"></a>

# ① &nbsp; AI Coding —— 详解

> **核心定位**：你只管说需求，它自己拆任务、自己跑工具、卡住会问你、做错被你骂之后还会**永久记住**。

## 基本用法

**1. 自然语言描述需求**（中英文都行）：

```
帮我把 src/agent/AgentLoop.ts 里硬编码的 25 轮迭代上限改成可配置的，
读一下 package.json 的 contributes.configuration 加上对应的设置项，
最后跑一下 lint。
```

**2. 它自己干活**：读文件 → 跳定义 → 查引用 → grep → 生成 diff。
你只需要在每次写盘前 **接受 / 拒绝** 它的修改。

**3. 不满意一键回滚**：每次写盘前都打 Git 快照（`refs/burstcode/checkpoints/<时间戳>`），
运行 **`BurstCode: Restore Git Checkpoint`** 选时间点回去。

<br />

## 三个让它"像人"的高级特性

### 🎯 自动 Plan —— 复杂任务自己拆步骤

任务一旦不平凡（多文件 / 多步骤 / 长调查），它会主动调用 `update_plan` 工具，
在 Chat 面板上方画出一个**实时勾选的清单**：

```
✅ 1. 读 AgentLoop.ts，定位 maxIterations 常量
🔄 2. 在 package.json 添加 burstcode.agent.maxIterations 设置项     ← 进行中
⬜ 3. 修改 AgentLoop 构造函数从配置读取
⬜ 4. 跑 lint 验证
```

- 同一时间最多有 **1 个 in_progress** 步骤（强约束，模型违反会被拒绝）
- 完成步骤实时 ✅，你随时知道它在哪一步
- Plan 会持久化到当前会话，刷新也不丢

> 简单一句话的请求（"重命名这个变量"）不会触发 Plan —— 系统提示明确要求只在非平凡任务时调用。

<br />

### ❓ 阻塞式提问 —— 不确定就停下来问你

模糊的需求不会被偷偷"猜测"。一旦发现两条以上合理路径、文件名匹配多个、
或者关键参数缺失，模型会调用 `ask_user` **暂停整个 Agent 循环**，在 Chat 面板弹出三种交互之一：

| 类型 | UI | 例子 |
|---|---|---|
| `single` | 单选 | *"找到 3 个 `UserService.ts`，你指的是哪个？"* |
| `multi` | 多选 | *"以下重构哪些要应用？"* |
| `text` | 文本框 | *"新接口想叫什么名字？"* |

`single`/`multi` 还可以带 `allowCustomText` 在选项下方再开一个自由输入框，让你回答 *"都不是，理由如下..."*。

**Stuck 自动升级**：如果模型连续 3 轮以同样的参数调同一个工具（明显死循环），
Agent 会主动用 `ask_user` 把球踢回给你：

> *"The agent appears to be stuck — it has called read_file('foo.ts', 1, 200) 3 times in a row. How would you like to proceed?"*
> → [继续] [停止] [自定义提示...]

不会再有那种"它一直跑、token 烧完、什么也没干成"的窘境。

<br />

### 🧠 自我进化 —— 被你纠正一次就永久记住

这是 BurstCode 最特别的能力。每次你说：

- *"不对，应该用 X 而不是 Y"*
- *"重要规则：这个项目所有文件都要 ..."*
- *"以后别在 `Foo.ts` 里加 `console.log`"*

模型会调用 `record_lesson` 把这条规则**永久写进本地 Memento 存储**，并打上 scope 标签：

```
[l_lf3a8_qx2k1]  file=src/agent/AgentLoop.ts symbol=run :: 取消 token 必须放最后一个参数
[l_lf3b2_8mzpx]  IMPORTANT global :: 所有用户可见字符串都用 i18n.t() 包起来
[l_lf3c9_w7tdm]  tags=performance :: 不要在循环里 await，先批量再 Promise.all
```

下一次（**包括重启 IDE 之后**）你再开 Chat，这些 lessons 会被注入到系统提示里：

- 标了 `important: true` 的规则进 **CRITICAL RULES** 区，永不被截断
- 普通 lessons 进 **SCOPED LESSONS** 区，按 4000 字符预算软截断
- 上限 200 条，超出时优先淘汰非 important 的旧条目

发现某条规则过时？说一句 *"那条规则不对了，删掉"*，模型会调 `forget_lesson(id)` 主动删除。
也可以让它一步到位用 `record_lesson(supersedes=[...])` 替换旧规则。

> 它不是"短期记忆"，是真正的**跨会话长期记忆**，存在 VS Code 的 globalState 里。

<br />

## 你能感受到的其他差异

| | |
|---|---|
| **真正的工具循环** | 自己迭代直到任务完成（受 `agent.maxIterations` 限制，默认 25） |
| **Hunk 级审阅** | 每个修改都是独立 hunk，可逐个接 / 拒，也可一键全收 |
| **深度 LSP 集成** | 用你已装的语言服务器，不是 grep —— 跨 import / re-export 都跳得对 |
| **预热的工作区索引** | 启动时一次性把工程结构嵌入系统提示，模型从第一句话起就知道项目长什么样 |
| **上下文用量仪表** | Chat 面板顶部实时显示 token 占用，≥ 90% 自动压缩历史 |
| **自动续写** | 因输出 token 上限被截断时自动续写（最多 3 轮，可关） |
| **多端点切换** | 模型选择器按端点分组，本地 Ollama / 公司 vLLM / 远程网关随意切 |

<br />

## AI Coding 命令速查

| 命令 | 用途 |
|---|---|
| `BurstCode: New Chat` | 开新会话（旧会话自动入历史） |
| `BurstCode: Select Active Model` | 切换端点 + 模型 |
| `BurstCode: Configure Model` | 跳到设置项 |
| `BurstCode: Accept Hunk` / `Reject Hunk` | 单个 hunk 接 / 拒 |
| `BurstCode: Accept All Pending Suggestions` | 一键全收 |
| `BurstCode: Reject All Pending Suggestions` | 一键全拒 |
| `BurstCode: Restore Git Checkpoint` | 列出快照、回滚 |

<br />

## 关键配置项

```jsonc
// 写盘前是否需要人工确认（强烈建议保持 true）
"burstcode.agent.requireConfirmBeforeEdit": true,

// 单次请求最多迭代轮数。复杂重构可调到 50；调研类可调到 100
"burstcode.agent.maxIterations": 25,

// 输出被截断时自动续写
"burstcode.agent.autoContinueOnLength": true,
"burstcode.agent.maxAutoContinues": 3,

// 写盘前自动打 Git 快照
"burstcode.git.autoCheckpoint": true
```

<br />

---

<br />

<a id="background-intelligence"></a>

# ② &nbsp; Background Intelligence —— 详解

> **核心定位**：你去吃饭、开会、睡觉，BurstCode 不闲着 —— 它替你读代码。
>
> 等你回到键盘，工程根目录多了一份 *昨晚发生了什么* 的报告。

## 它会自动产出什么

所有产物都写到工作区根目录的 `.burstcode/` 文件夹（已自动 gitignore）：

```
.burstcode/
├── README.md             ← 总览：跑了多少轮、找到几个 bug、生成几个测试
├── project-brief.md      ← 工程级理解：项目在干嘛、关键模块、调查清单
├── docs/
│   └── src/foo/Bar.ts.md ← 每个源文件一份：摘要、设计要点、热点、调用关系
├── topics/
│   └── auth-flow.md      ← 跨文件主题报告：登录链路、状态管理、错误传播…
├── bugs.md               ← 滚动追加的疑似 Bug 列表（带文件 + 行号 + 推理）
├── tests/
│   └── src/foo/Bar.ts.d/ ← 自动生成的单测，TS/JS 用 vitest，Python 用 pytest…
│       └── *.result.md   ← 自动执行后的结果（开关：runGeneratedTests）
├── verifications.md      ← 每次测试运行的滚动日志（pass/fail/skip）
└── activity.log          ← 完整时间戳活动日志
```

## 启用与禁用

后台默认是**关闭**的（避免装完就偷偷跑模型）。三种方式启停：

| 方式 | 启 | 停 |
|---|---|---|
| **设置项** | `"burstcode.background.enabled": true` | 改成 `false` |
| **命令面板** | `BurstCode: Toggle Background Code Explorer` | 同一条命令再点一次 |
| **Chat 面板** | 右下角状态药丸 → *Enable Background Explorer* | 药丸 → *Disable* |

启用后状态药丸会显示当前阶段：*idle-waiting* / *running* / *paused-by-chat* / *paused-by-typing*。
点药丸还能直接进 **Background Explorer Menu**，所有控制项一站式。

> 临时跑一次（不等空闲）：`BurstCode: Run Background Analysis Now`。

<br />

## 后台用哪个模型？三种配法

后台跑的轮次远多于 Chat —— 强烈建议给它**单独配一个更小、更便宜的模型**。
按"耦合度"从低到高三种模式：

### 模式 A · 完全继承 Chat（零配置）

什么都不写，后台就用你 Chat 当前激活的端点 + 模型。

```jsonc
// settings.json 不写任何 burstcode.background.endpoint / baseURL / model 即可
```

适合：刚装完想试试，或本地只跑一个模型。

### 模式 B · 复用已有端点，换个小模型（推荐）

引用 `burstcode.llm.endpoints` 里某个端点的 `name`，再单独指定一个该端点上更轻的模型：

```jsonc
"burstcode.background.endpoint": "Local Ollama",     // 引用 llm.endpoints[*].name
"burstcode.background.model":    "qwen2.5-coder:1.5b" // 比 Chat 用的更小
```

适合：服务还是同一个 Ollama / vLLM，但希望 Chat 用 14B 大模型保质量、后台用 1.5B 小模型省电。

### 模式 C · 完全独立的服务（最高隔离）

把后台彻底和 Chat 解耦 —— 例如另一台旧电脑上的 Ollama，或者一个共享小模型网关：

```jsonc
"burstcode.background.baseURL":   "http://192.168.1.50:11434/v1",
"burstcode.background.apiKey":    "ollama",
"burstcode.background.model":     "qwen2.5-coder:3b",
"burstcode.background.contextWindow": 8192,
"burstcode.background.temperature":   0.2,
"burstcode.background.allowSelfSignedCerts": false
```

> 一旦设了 `baseURL`，就**完全无视** `endpoint` 字段，所有连接参数走 background.* 自己的。

适合：希望后台跑在另一台机器、另一张 GPU、或公司专门的"长任务"网关上。

### 配完后切模型

不想改 JSON？运行 **`BurstCode: Select Background Explorer Model`** 直接弹 QuickPick 切。

<br />

## 顺便跑测试（可选，默认关）

```jsonc
"burstcode.background.runGeneratedTests": true,
"burstcode.background.testRunTimeoutMs": 60000
```

开启后：

- TS/JS：自动调 `npx vitest` 或 `npx jest`
- Python：自动调 `pytest`（首次会在 `.burstcode/tests/conftest.py` 注入 sys.path）
- 每次测试的 *通过 / 失败 / 跳过 / 超时* 都写进 `verifications.md` 和对应的 `*.result.md`

> ⚠️ 它会真的执行生成的代码 —— 在不信任的工程上启用前请先人工 review `tests/` 里的内容。

<br />

## 内部机制

理解它在干嘛，调起来更顺手。

### 一轮 cycle 长什么样

```
   ┌─ 用户停止键入 ≥ idleThresholdMs (默认 10s)
   │   且距离上一轮 ≥ minIntervalMs (默认 30s)
   ▼
1. 规划阶段（Planner）
   读工作区大纲 + 关键文件
   ├─ 写 .burstcode/project-brief.md   （工程级理解）
   └─ 生成 N 个调查 topic 进入 backlog （登录链路、错误传播…）
   ▼
2. 调查阶段（Topic Agent，最多 maxConcurrentTopics 并发）
   每个 topic 跑一个独立 AgentLoop（只读工具：read_file/list_dir/grep_search/outline）
   ├─ 写 topics/<id>.md         （主题报告）
   ├─ append bugs.md            （疑似 bug）
   └─ 写 tests/<topic>/*.test.* （针对模型"看不准"点的单测）
   ▼
3. 文件阶段（File Agent，增量）
   挑 filesPerCycle 个 hash 变了的源文件
   ├─ 写 docs/<source-path>.md  （摘要 + 热点 + 调用关系）
   ├─ append bugs.md
   └─ 写 tests/<source>.d/*
   ▼
4. 验证阶段（仅 runGeneratedTests=true）
   逐个 spawn vitest / jest / pytest
   ├─ 写 tests/**/*.result.md
   └─ append verifications.md
   ▼
5. 收尾：state.json 落盘（hash + counters），更新 .burstcode/README.md
```

### 暂停规则（绝不抢资源）

| 触发 | 行为 |
|---|---|
| 你开始打字 | 当前 cycle 立即暂停，状态变 *paused-by-typing* |
| Chat 开始一次请求 | 当前 cycle 立即暂停，状态变 *paused-by-chat* |
| 单文件 / Planner 超时（`perFileTimeoutMs`，默认 5 min） | 该任务取消，cycle 继续下一个 |
| Topic 调查超时（`perFileTimeoutMs × 4`，默认 20 min） | 该 topic 取消，并发的其它 topic 继续 |
| 总开关被关 | 当前 cycle 取消，所有 LLM 流终止 |

### 增量与去重

- 每个文件按 SHA-1 算 hash，存进 `.burstcode/state.json`
- 下一轮跳过 hash 没变的文件 —— **只看新东西**
- 想全部重跑？运行 `BurstCode: Reset Background Explorer State`，清空 hash 即可
- 删除整个 `.burstcode/` 文件夹也安全，下一轮会自动重建

### 一些硬约束

- 单轮文件数 = `filesPerCycle`（默认 1）—— 慢工出细活，不堆请求
- 单轮并发 topic = `maxConcurrentTopics`（默认 10）—— 端点扛得住就开大
- 单文件硬上限 = `maxFileBytes`（默认 120 KB）—— 超过直接跳，避免炸上下文
- 只看 `includeExtensions` 列出的扩展名 —— 默认覆盖 20+ 主流语言

<br />

## 后台命令速查

| 命令 | 用途 |
|---|---|
| `BurstCode: Toggle Background Code Explorer` | 启 / 停 |
| `BurstCode: Run Background Analysis Now` | 立即跑一轮（不等空闲） |
| `BurstCode: Select Background Explorer Model` | 单独为后台选模型 |
| `BurstCode: Show Background Explorer Report` | 打开 `.burstcode/README.md` |
| `BurstCode: Show Background Explorer Activity Log` | 打开 Output 通道实时看进度 |
| `BurstCode: Reset Background Explorer State` | 清空 hash，让所有文件重新分析 |
| `BurstCode: Background Explorer Menu` | 状态药丸的菜单入口（一站式） |

<br />

## 完整配置项

```jsonc
// ── 总开关 ─────────────────────────────────────
"burstcode.background.enabled": false,

// ── 节律（什么时候跑、跑多频）──────────────────
"burstcode.background.idleThresholdMs":   10000,   // 用户停手多久后开始
"burstcode.background.minIntervalMs":     30000,   // 两轮最小间隔
"burstcode.background.filesPerCycle":     1,       // 每轮分析几个文件
"burstcode.background.maxConcurrentTopics": 10,    // 单轮并发主题数
"burstcode.background.perFileTimeoutMs":  300000,  // 单文件 / Planner 超时；Topic 取此值 × 4

// ── 范围（看哪些文件）──────────────────────────
"burstcode.background.includeExtensions": [
  "ts","tsx","js","jsx","py","go","rs","java","kt",
  "c","cpp","cs","rb","php","swift","scala","lua","dart"
],
"burstcode.background.maxFileBytes": 120000,       // 超过此值直接跳

// ── 端点 / 模型（独立于 Chat）─────────────────
"burstcode.background.endpoint":  "",              // 引用 llm.endpoints[*].name
"burstcode.background.baseURL":   "",              // 设了它就完全独立
"burstcode.background.apiKey":    "",
"burstcode.background.allowSelfSignedCerts": false,
"burstcode.background.model":     "",              // 留空 = 端点默认 / 继承 Chat
"burstcode.background.temperature":   0.2,
"burstcode.background.contextWindow": 0,           // 0 = 继承端点

// ── 输出与执行 ─────────────────────────────────
"burstcode.background.outputDir": ".burstcode",
"burstcode.background.runGeneratedTests": false,   // 自动跑生成的测试
"burstcode.background.testRunTimeoutMs": 60000
```

完整描述（每项的英文文档）见 `package.json` 的 `contributes.configuration`（搜 `burstcode.background.`）。

<br />

---

<br />

## 兼容性

只要服务说 OpenAI 协议（`/v1/chat/completions` + `/v1/models`）就能接：

**Ollama** · **LM Studio** · **vLLM** · **llama.cpp / llama-server** · **TGI** · **OpenRouter** · **Azure OpenAI** · 自建网关

支持任何已安装语言扩展的工程：TypeScript · Python · Go · Rust · Java · C/C++ · C# · Ruby · PHP · Swift · Kotlin · Scala · Lua · Dart …

---

## 开发

```powershell
npm install
npm run watch          # 增量编译
# 在 VS Code 按 F5 启动 Extension Host

npm run package        # 生产构建
npm run vsix           # 打 vsix
```

技术栈：TypeScript 5 · esbuild · openai SDK · gpt-tokenizer · diff · VS Code API ≥ 1.85

源码导航：

| 目录 | 内容 |
|---|---|
| `src/agent/` | Agent 主循环、提示词、工具实现（plan、ask_user、edits、lsp…） |
| `src/background/` | 后台代码探索器、单测执行 |
| `src/chat/` | Webview Chat 视图、会话存储 |
| `src/context/` | 工作区索引、大纲、上下文压缩 |
| `src/edits/` | Diff 预览、Hunk 应用器 |
| `src/git/` | Git checkpoint |
| `src/llm/` | OpenAI 兼容客户端 + tokenizer |
| `src/lsp/` | LSP 桥接 |
| `src/memory/` | Lesson 持久化（自我进化的存储） |

---

## License

MIT — 自由使用、修改、闭源分发，保留版权声明即可。详见 [`LICENSE`](LICENSE)。

<br />

<div align="center">

**模型留在你的机器里 · 代码留在你的仓库里**

如果 BurstCode 帮到你，欢迎 ⭐ Star · 提 Issue · 发 PR。

</div>
