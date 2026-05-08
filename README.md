<div align="center">

**English** · [简体中文](README.zh-CN.md)

</div>

<div align="center">

<img src="media/readme/hero.svg" alt="BurstCode" width="120" height="120" />

# BurstCode

*A local-first AI coding companion for VS Code.*

Powered by your own local models · Code never leaves your machine · Works with any OpenAI-compatible endpoint

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.106-1f1f1f?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/MIT-1f1f1f.svg)](LICENSE)
[![Local First](https://img.shields.io/badge/Local%20First-1f1f1f)](#)
[![Ollama](https://img.shields.io/badge/Ollama-1f1f1f)](https://ollama.com)
[![LM Studio](https://img.shields.io/badge/LM%20Studio-1f1f1f)](https://lmstudio.ai)
[![vLLM](https://img.shields.io/badge/vLLM-1f1f1f)](https://github.com/vllm-project/vllm)

</div>

<br />

<div align="center">

BurstCode does only two things — and does them well.

</div>

<br />

<table width="100%">
<tr>
<td width="50%" valign="top">

### ① &nbsp; AI Coding

A proactive, conversational coding partner.
Tell it what you want — it **plans, codes, asks when stuck, and remembers when corrected**.

→ [Detailed usage & configuration](#ai-coding)

</td>
<td width="50%" valign="top">

### ② &nbsp; Background Intelligence

Works silently in the background. While you're idle it reads your codebase
to produce docs, generate tests, and flag suspected bugs.

→ [Detailed usage & configuration](#background-intelligence)

</td>
</tr>
</table>

---

# Install & First-Time Setup

## Step 1 · Run a local model

BurstCode does not bundle a model. Pick any OpenAI-compatible service.

<details open>
<summary><b>Option A: Ollama (easiest, recommended)</b></summary>

```bash
# 1. Install Ollama → https://ollama.com/download
# 2. Pull a coding model
ollama pull qwen2.5-coder:7b      # 7B, fits in 16 GB RAM
# or:
ollama pull qwen2.5-coder:14b     # 14B, better quality, needs 32 GB

# 3. Start the server (default: http://localhost:11434)
ollama serve
```

</details>

<details>
<summary><b>Option B: LM Studio (GUI, no command line)</b></summary>

1. Install LM Studio → https://lmstudio.ai
2. In *Discover*, search and download a coding model (e.g. `Qwen2.5-Coder-7B-Instruct-GGUF`)
3. Switch to *Local Server* → **Start Server**
4. Default endpoint: `http://localhost:1234/v1`

</details>

<details>
<summary><b>Option C: vLLM (production-grade, requires GPU)</b></summary>

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-Coder-7B-Instruct \
  --served-model-name qwen2.5-coder \
  --port 8000
# Endpoint: http://localhost:8000/v1
```

</details>

> Anything that speaks `/v1/chat/completions` works: llama.cpp, TGI, OpenRouter, Azure OpenAI, custom gateways…

## Step 2 · Install the extension

```powershell
code --install-extension burstcode-0.1.8.vsix
```

Or build it from source:

```powershell
npm install
npm run package
npm run vsix          # produces burstcode-0.1.8.vsix
```

After install you'll see two BurstCode surfaces:

- **Primary Side Bar** (⚡ icon in the activity bar) — the *BurstCode* panel: model picker, permissions, background-explorer toggles, quick actions.
- **Secondary Side Bar** — the *BurstCode Chat* panel itself, so it lives next to your editor without competing with the file explorer.
- **Editor title bar** — a BurstCode logo button (`Open Chat`) that focuses the chat panel from anywhere.

If the Secondary Side Bar is hidden, run `View: Toggle Secondary Side Bar` (`Ctrl+Alt+B`) once.

## Step 3 · Register an endpoint

Open VS Code settings (`Ctrl+,`), search for `burstcode.llm.endpoints`, click *Edit in settings.json*.

### Minimal (recommended) — endpoint only, fetch models on demand

If your service supports `/v1/models` (Ollama / LM Studio / vLLM / OpenRouter all do),
you don't even need to list models:

```jsonc
"burstcode.llm.endpoints": [
  {
    "name": "Local Ollama",
    "baseURL": "http://localhost:11434/v1",
    "apiKey": "ollama"
  }
]
```

After saving:

- **Way 1 (in Chat panel)**: click the model picker at the bottom → press the ↻ **Refresh** button next to the endpoint →
  models are fetched online → click one to activate
- **Way 2 (Command Palette)**: `Ctrl+Shift+P` → **`BurstCode: Select Active Model`** →
  pick *☁ Fetch models from this endpoint* → choose one

Don't want to hit the network? Pick *➕ Add custom model id...* and type one (e.g. `qwen2.5-coder:7b`).

### Full version — preset model list + multiple endpoints

If you want to pre-list common models or manage several endpoints:

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

The model picker groups by endpoint, and every endpoint has its own ↻ Refresh button. Done ✅.

## Step 4 · Open Chat and try a prompt

Click the ⚡ icon → *BurstCode Chat* → type:

> *"Read `src/extension.ts` and draw me a component dependency graph."*

If it starts reading files, listing the outline, and replies with an architectural summary, you're good to go.

## Step 5 (optional) · Enable background silent analysis

The background code explorer is **disabled by default** — it won't quietly run a model the moment you install.
To let it read code, find bugs, generate tests, and write docs while you're not typing, pick one of three:

```jsonc
// settings.json
"burstcode.background.enabled": true
```

Or Command Palette: `BurstCode: Toggle Background Code Explorer`
Or click the status pill at the bottom-right of the Chat panel → *Enable Background Explorer*.

> 💡 Strongly recommend giving the background loop **its own smaller, cheaper model** (saves power and VRAM) —
> see ["Three ways to configure"](#background-intelligence) under ② Background Intelligence.

<br />

## Where to next

<table width="100%">
<tr>
<td width="50%" valign="top" align="center">

### → [① AI Coding details](#ai-coding)

Basic usage · Auto Plan · Blocking questions · Self-evolving lessons
Command cheatsheet · Key settings

</td>
<td width="50%" valign="top" align="center">

### → [② Background Intelligence details](#background-intelligence)

Enable / disable · Independent endpoint & model (3 modes)
Internal mechanics · Full settings reference

</td>
</tr>
</table>

<br />

---

<br />

<a id="ai-coding"></a>

# ① &nbsp; AI Coding —— deep dive

> **The pitch**: just describe what you want. It breaks down the task, runs tools, asks when stuck, and **remembers permanently** when you correct it.

## Basic usage

**1. Describe what you want in natural language** (English or Chinese, both work):

```
Take the hardcoded 25-iteration limit in src/agent/AgentLoop.ts and make it
configurable. Add the matching setting to package.json's contributes.configuration.
Then run lint.
```

**2. It does the work**: read files → jump to definition → find references → grep → produce a diff.
You only need to **accept / reject** before any write hits disk.

**3. Don't like the result? Roll back.** Every disk write is preceded by a Git snapshot
(`refs/burstcode/checkpoints/<timestamp>`). Run **`BurstCode: Restore Git Checkpoint`** and pick a point in time.

<br />

## Three features that make it feel "human"

### 🎯 Auto Plan — non-trivial tasks decompose themselves

Once a task is non-trivial (multiple files / multiple steps / longer investigation), the model proactively
calls the `update_plan` tool and renders a **live checklist** at the top of the Chat panel:

```
✅ 1. Read AgentLoop.ts; locate the maxIterations constant
🔄 2. Add burstcode.agent.maxIterations to package.json     ← in progress
⬜ 3. Update AgentLoop constructor to read from config
⬜ 4. Run lint to verify
```

- At most **one step is `in_progress`** at any time (a hard rule — violations are rejected by the tool)
- Steps tick off live ✅ — you always know where it is
- The plan is persisted to the current chat session and survives reloads

> One-liner asks ("rename this variable") don't trigger a plan — the system prompt explicitly tells the model to skip planning for trivial tasks.

<br />

### ❓ Blocking questions — when unsure, it stops and asks

Ambiguous requests don't get silently "guessed". The moment the model finds two plausible paths,
multiple matching files, or a missing critical parameter, it calls `ask_user`, **pausing the entire agent loop**
and showing one of three UIs in Chat:

| Type | UI | Example |
|---|---|---|
| `single` | radio | *"I found 3 `UserService.ts` files — which one did you mean?"* |
| `multi` | checkboxes | *"Which of these refactors should I apply?"* |
| `text` | text box | *"What should the new endpoint be named?"* |

`single`/`multi` can also set `allowCustomText` to add a free-text field below the options for *"none of the above, here's why..."* answers.

**Auto-escalation when stuck**: if the model calls the same tool with the same arguments 3 turns in a row (an obvious loop),
the agent itself fires an `ask_user` to bounce the ball back to you:

> *"The agent appears to be stuck — it has called read_file('foo.ts', 1, 200) 3 times in a row. How would you like to proceed?"*
> → [Continue] [Stop] [Custom hint...]

No more "it ran for 25 turns, burned all the tokens, and got nothing done."

<br />

### 🧠 Self-evolution — correct it once, it remembers forever

This is BurstCode's most distinctive ability. Whenever you say something like:

- *"No, use X instead of Y"*
- *"Important rule: every file in this project must ..."*
- *"From now on, never add `console.log` to `Foo.ts`"*

the model calls `record_lesson` to **persist the rule into local Memento storage**, scope-tagged:

```
[l_lf3a8_qx2k1]  file=src/agent/AgentLoop.ts symbol=run :: cancellation token must be the LAST parameter
[l_lf3b2_8mzpx]  IMPORTANT global :: wrap all user-visible strings with i18n.t()
[l_lf3c9_w7tdm]  tags=performance :: never await inside a loop — batch then Promise.all
```

Next time you open Chat (**including after restarting the IDE**), these lessons are injected into the system prompt:

- Lessons flagged `important: true` go into a **CRITICAL RULES** section, never truncated
- Ordinary lessons go into **SCOPED LESSONS** with a 4000-char soft budget
- 200-entry cap; when full, ordinary entries are evicted before important ones

A rule went stale? Just say *"that rule is wrong now, drop it"* — the model calls `forget_lesson(id)` to delete it.
Or use `record_lesson(supersedes=[...])` in one shot to replace an old rule with a new one.

> This is not "short-term memory" — it's true **cross-session long-term memory**, persisted in VS Code's globalState.

<br />

## Other things you'll notice

| | |
|---|---|
| **Real tool loop** | Iterates until the task is done (capped by `agent.maxIterations`, default 25) |
| **Hunk-level review** | Every change is an independent hunk — accept / reject one at a time, or batch-accept all |
| **Deep LSP integration** | Uses your installed language servers, not grep — cross-import / re-export jumps work correctly |
| **Pre-warmed workspace index** | At startup the project structure is embedded into the system prompt, so the model knows the codebase from sentence one |
| **Context usage meter** | Top of Chat panel shows live token usage; ≥ 90% triggers automatic history compression |
| **Auto-continue** | When output is cut off by max-tokens, it auto-resumes (up to 3 rounds, configurable) |
| **Multi-endpoint** | Model picker is grouped by endpoint — switch freely between local Ollama / company vLLM / remote gateway |

<br />

## AI Coding command cheatsheet

| Command | Purpose |
|---|---|
| `BurstCode: New Chat` | Start a new chat (current session goes to history) |
| `BurstCode: Select Active Model` | Switch endpoint + model |
| `BurstCode: Configure Model` | Jump to settings |
| `BurstCode: Accept Hunk` / `Reject Hunk` | Per-hunk accept / reject |
| `BurstCode: Accept All Pending Suggestions` | Accept everything in one shot |
| `BurstCode: Reject All Pending Suggestions` | Reject everything in one shot |
| `BurstCode: Restore Git Checkpoint` | List snapshots, roll back |

<br />

## Key settings

```jsonc
// Require human confirmation before disk write (strongly recommended: keep true)
"burstcode.agent.requireConfirmBeforeEdit": true,

// Max tool-iteration rounds per request. Heavy refactors: 50. Investigations: 100
"burstcode.agent.maxIterations": 25,

// Auto-continue when output is truncated by max-tokens
"burstcode.agent.autoContinueOnLength": true,
"burstcode.agent.maxAutoContinues": 3,

// Auto Git snapshot before disk write
"burstcode.git.autoCheckpoint": true
```

<br />

---

<br />

<a id="background-intelligence"></a>

# ② &nbsp; Background Intelligence —— deep dive

> **The pitch**: while you're at lunch, in a meeting, or asleep, BurstCode isn't idle — it's reading your code.
>
> When you come back to the keyboard, there's a *"what happened last night"* report waiting in your repo.

## What it produces

Everything goes into the workspace-level `.burstcode/` directory (auto-gitignored):

```
.burstcode/
├── README.md             ← Overview: cycles run, bugs found, tests generated
├── project-brief.md      ← Project-level understanding: what this project does, key modules, investigation backlog
├── docs/
│   └── src/foo/Bar.ts.md ← One per source file: summary, design notes, hot spots, call graph
├── topics/
│   └── auth-flow.md      ← Cross-file topic reports: login flow, state management, error propagation…
├── bugs.md               ← Rolling list of suspected bugs (file + line + reasoning)
├── tests/
│   └── src/foo/Bar.ts.d/ ← Auto-generated unit tests (vitest for TS/JS, pytest for Python…)
│       └── *.result.md   ← Per-test execution result (when runGeneratedTests is on)
├── verifications.md      ← Rolling log of every test execution (pass/fail/skip)
└── activity.log          ← Full timestamped activity log
```

## Enable & disable

The background loop is **disabled by default** (so installing doesn't quietly start running a model). Three ways to flip it:

| Method | Enable | Disable |
|---|---|---|
| **Setting** | `"burstcode.background.enabled": true` | set to `false` |
| **Command Palette** | `BurstCode: Toggle Background Code Explorer` | run the same command again |
| **Chat panel** | bottom-right status pill → *Enable Background Explorer* | pill → *Disable* |

When enabled, the status pill shows the current phase: *idle-waiting* / *running* / *paused-by-chat* / *paused-by-typing*.
Clicking the pill also opens the **Background Explorer Menu** — one-stop access to all controls.

> One-shot run (don't wait for idle): `BurstCode: Run Background Analysis Now`.

<br />

## Which model should the background use? Profiles

BurstCode uses a single **profile** concept: a `(endpoint, model)` pair. There are
two profiles — `chat` and `background`. The model itself only ever lives in
`burstcode.llm.endpoints`; profiles just *point at* one of those entries.

### Mode A · Inherit Chat (default, zero config)

The background profile starts with `inherit: true`, so it uses whatever Chat is
on. Best for: just installed, or only running one local model.

```jsonc
"burstcode.profiles.background.inherit": true   // ← the default; nothing else needed
```

### Mode B · Pin to a smaller / cheaper model (recommended)

Keep one entry in `burstcode.llm.endpoints` and point the background profile at
a lighter model on the same server:

```jsonc
"burstcode.profiles.background.inherit":  false,
"burstcode.profiles.background.endpoint": "http://localhost:11434/v1",  // an entry in llm.endpoints
"burstcode.profiles.background.model":    "qwen2.5-coder:1.5b"          // smaller than Chat's
```

Best for: same Ollama / vLLM, but you want Chat at 14B for quality and background
at 1.5B for efficiency.

### Mode C · A completely separate server

There are no longer dedicated `burstcode.background.baseURL/apiKey/...` keys.
Just add another entry to `burstcode.llm.endpoints` and point the background
profile at it:

```jsonc
"burstcode.llm.endpoints": [
  { "name": "http://localhost:11434/v1",      "baseURL": "http://localhost:11434/v1",      "models": ["qwen2.5-coder:14b"] },
  { "name": "http://192.168.1.50:11434/v1",   "baseURL": "http://192.168.1.50:11434/v1",   "apiKey": "ollama", "models": ["qwen2.5-coder:3b"] }
],
"burstcode.profiles.chat.endpoint":       "http://localhost:11434/v1",
"burstcode.profiles.chat.model":          "qwen2.5-coder:14b",
"burstcode.profiles.background.inherit":  false,
"burstcode.profiles.background.endpoint": "http://192.168.1.50:11434/v1",
"burstcode.profiles.background.model":    "qwen2.5-coder:3b"
```

Best for: running the background loop on another machine, another GPU, or a
dedicated "long-running tasks" gateway at work.

### Switch model without editing JSON

In the BurstCode side panel, click **Models → Background**, or run
**`BurstCode: Select Background Explorer Model`** — a QuickPick lists every
registered endpoint+model plus an *Inherit chat* option. Picking writes
`burstcode.profiles.background.*` for you.

<br />

## Run generated tests too (optional, off by default)

```jsonc
"burstcode.background.runGeneratedTests": true,
"burstcode.background.testRunTimeoutMs": 60000
```

When enabled:

- TS/JS: invokes `npx vitest` or `npx jest`
- Python: invokes `pytest` (a `.burstcode/tests/conftest.py` is dropped on first use to fix sys.path)
- Each test's *pass / fail / skip / timeout* is written to `verifications.md` and the matching `*.result.md`

> ⚠️ It actually executes the generated code — review files under `tests/` before enabling on untrusted projects.

<br />

## Internal mechanics

Understanding what it does makes tuning easier.

### What a single cycle looks like

```
   ┌─ User idle ≥ idleThresholdMs (default 10s)
   │   AND ≥ minIntervalMs since last cycle (default 30s)
   ▼
1. Plan phase (Planner)
   Reads workspace outline + key files
   ├─ Writes .burstcode/project-brief.md   (project-level understanding)
   └─ Generates N investigation topics into the backlog (login flow, error paths…)
   ▼
2. Investigation phase (Topic Agent — up to maxConcurrentTopics in parallel)
   Each topic runs an independent AgentLoop (read-only tools: read_file/list_dir/grep_search/outline)
   ├─ Writes topics/<id>.md         (topic report)
   ├─ Appends bugs.md               (suspected bugs)
   └─ Writes tests/<topic>/*.test.* (unit tests for points the model is uncertain about)
   ▼
3. File phase (File Agent — incremental)
   Picks filesPerCycle source files whose hash changed
   ├─ Writes docs/<source-path>.md  (summary + hotspots + call graph)
   ├─ Appends bugs.md
   └─ Writes tests/<source>.d/*
   ▼
4. Verify phase (only when runGeneratedTests=true)
   Spawns vitest / jest / pytest one by one
   ├─ Writes tests/**/*.result.md
   └─ Appends verifications.md
   ▼
5. Wrap-up: state.json (hashes + counters), refresh .burstcode/README.md
```

### Pause rules (never steals resources)

| Trigger | Action |
|---|---|
| You start typing | Current cycle pauses immediately, status becomes *paused-by-typing* |
| Chat starts a request | Current cycle pauses immediately, status becomes *paused-by-chat* |
| Single-file / Planner timeout (`perFileTimeoutMs`, default 5 min) | That task is cancelled, cycle moves on |
| Topic timeout (`perFileTimeoutMs × 4`, default 20 min) | That topic is cancelled; concurrent topics continue |
| Master switch turned off | Whole cycle cancelled, all LLM streams terminated |

### Incremental & dedup

- Each file is hashed (SHA-1) and stored in `.burstcode/state.json`
- The next cycle skips files whose hash is unchanged — **only sees what's new**
- Want to redo everything? Run `BurstCode: Reset Background Explorer State` to clear the hash map
- Deleting the entire `.burstcode/` folder is safe — it's regenerated on the next cycle

### Hard limits

- Files per cycle = `filesPerCycle` (default 1) — slow and steady, no request flooding
- Concurrent topics = `maxConcurrentTopics` (default 10) — crank it up if your endpoint can handle it
- Hard file size limit = `maxFileBytes` (default 120 KB) — bigger files are skipped to protect the context window
- Only files in `includeExtensions` are considered — defaults cover 20+ mainstream languages

<br />

## Background command cheatsheet

| Command | Purpose |
|---|---|
| `BurstCode: Toggle Background Code Explorer` | Enable / disable |
| `BurstCode: Run Background Analysis Now` | Run a cycle now (don't wait for idle) |
| `BurstCode: Select Background Explorer Model` | Pick the background-only model |
| `BurstCode: Show Background Explorer Report` | Open `.burstcode/README.md` |
| `BurstCode: Show Background Explorer Activity Log` | Open the live Output channel |
| `BurstCode: Reset Background Explorer State` | Clear file hashes — re-analyse everything |
| `BurstCode: Background Explorer Menu` | One-stop menu (the status pill) |

<br />

## Full settings reference

```jsonc
// ── Master switch ──────────────────────────────
"burstcode.background.enabled": false,

// ── Cadence (when and how often) ───────────────
"burstcode.background.idleThresholdMs":   10000,   // idle gap before a cycle starts
"burstcode.background.minIntervalMs":     30000,   // minimum gap between cycles
"burstcode.background.filesPerCycle":     1,       // files analysed per cycle
"burstcode.background.maxConcurrentTopics": 10,    // concurrent topics per cycle
"burstcode.background.perFileTimeoutMs":  300000,  // single-file / planner timeout; topic uses 4× this

// ── Scope (which files) ────────────────────────
"burstcode.background.includeExtensions": [
  "ts","tsx","js","jsx","py","go","rs","java","kt",
  "c","cpp","cs","rb","php","swift","scala","lua","dart"
],
"burstcode.background.maxFileBytes": 120000,       // skip files larger than this

// ── Endpoint / model (driven by profiles) ─────
// `burstcode.background.endpoint/model/baseURL/apiKey/...` no longer exist.
// Configure via the unified profiles instead:
"burstcode.profiles.background.inherit":  true,    // true = use Chat's profile
"burstcode.profiles.background.endpoint": "",      // entry name in burstcode.llm.endpoints
"burstcode.profiles.background.model":    "",      // empty = endpoint's first known model

// ── Output & execution ────────────────────────
"burstcode.background.outputDir": ".burstcode",
"burstcode.background.runGeneratedTests": false,   // auto-execute generated tests
"burstcode.background.testRunTimeoutMs": 60000
```

Full per-key documentation lives in `package.json` under `contributes.configuration` (search for `burstcode.background.`).

<br />

---

<br />

## Compatibility

Any service that speaks the OpenAI protocol (`/v1/chat/completions` + `/v1/models`) works:

**Ollama** · **LM Studio** · **vLLM** · **llama.cpp / llama-server** · **TGI** · **OpenRouter** · **Azure OpenAI** · custom gateways

Works with any project that has a VS Code language extension installed: TypeScript · Python · Go · Rust · Java · C/C++ · C# · Ruby · PHP · Swift · Kotlin · Scala · Lua · Dart …

---

## Development

```powershell
npm install
npm run watch          # incremental compile
# Press F5 in VS Code to launch the Extension Host

npm run package        # production build
npm run vsix           # produce vsix
```

Stack: TypeScript 5 · esbuild · openai SDK · gpt-tokenizer · diff · VS Code API ≥ 1.106

Source map:

| Directory | Contents |
|---|---|
| `src/agent/` | Agent main loop, prompts, tool implementations (plan, ask_user, edits, lsp…) |
| `src/background/` | Background code explorer, test runner |
| `src/chat/` | Webview Chat view, session storage |
| `src/context/` | Workspace index, outline, context compression |
| `src/edits/` | Diff preview, hunk applier |
| `src/git/` | Git checkpoint |
| `src/llm/` | OpenAI-compatible client + tokenizer |
| `src/lsp/` | LSP bridge |
| `src/memory/` | Lesson persistence (where self-evolution lives) |

---

## License

MIT — free to use, modify, and redistribute (including in closed-source) as long as the copyright notice is kept. See [`LICENSE`](LICENSE).

<br />

<div align="center">

**Models stay on your machine · Code stays in your repo**

If BurstCode is useful, please ⭐ Star · file Issues · send PRs.

</div>
