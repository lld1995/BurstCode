<div align="center">

<img src="media/readme/hero.svg" alt="BurstCode" width="100%" />

# BurstCode

**A Windsurf-style autonomous coding agent for VS Code — powered entirely by your own local, OpenAI-compatible LLMs.**

Chat with your codebase, let the agent read, search, edit, build and test across files — all running against an endpoint you control (Ollama, vLLM, LM Studio, llama.cpp, or any `/v1`-compatible server). No cloud account, no telemetry, no per-token bill.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![VS Code ^1.106](https://img.shields.io/badge/VS%20Code-%5E1.106-007ACC.svg) ![Local LLM](https://img.shields.io/badge/LLM-local%20%2F%20OpenAI--compatible-success.svg)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## Table of contents

- [Why BurstCode](#why-burstcode)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configure your LLM](#configure-your-llm)
- [Usage](#usage)
- [The agent toolbox](#the-agent-toolbox)
- [Background Code Explorer](#background-code-explorer)
- [Commands](#commands)
- [Settings reference](#settings-reference)
- [Building from source](#building-from-source)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why BurstCode

Most agentic coding extensions assume you are sending your code to a hosted frontier model. BurstCode is built around the opposite assumption: **the model runs where you do.** Point it at any OpenAI-compatible `/v1` endpoint and it behaves like a full autonomous agent — planning multi-step work, batching tool calls, editing files with a review-and-rollback diff workflow, running your build and tests, and even exploring your codebase in the background while you work.

- **100% local-first** — your source never leaves your machine unless *you* point the endpoint at a remote server.
- **Bring your own model** — Qwen-Coder, DeepSeek-Coder, Llama, Codestral… anything your server exposes at `/v1/models`.
- **Two independent profiles** — a fast/large model for chat, a cheaper one for background work.
- **LSP-aware** — it uses the language server (go-to-def, references, implementations, hover) instead of blind text search, so refactors understand scope and re-exports.

---

## Features

| | |
|---|---|
| 🧠 **Autonomous agent loop** | Plans, batches parallel tool calls, self-corrects when stuck, and auto-continues across token-limit / stream-interruption boundaries. |
| ✏️ **Review-first edits** | Every change lands on disk immediately *and* is staged as a reviewable diff with per-hunk Accept / Reject. |
| 🔁 **Git checkpoints** | Each agent turn creates a restore point; roll the whole workspace back from the chat. |
| 🔍 **Semantic code navigation** | Go-to-definition, find-references, implementations, hover types, document & workspace symbols — driven by your installed language servers. |
| ⚡ **Batched context collection** | `collect_context` fans out reads + greps + dir listings + outlines in a single round-trip. |
| 🧵 **Concurrent sub-agents** | Offload isolated exploration / parallel edits to focused sub-agents with their own context windows. |
| 🌐 **Web tools** | Search the web and read pages/PDFs to pull in docs and error solutions. |
| 🖥️ **Shell execution** | Run builds, tests, linters and scripts — with an approval gate (or auto-approve for trusted workflows). |
| 🛰️ **Background Code Explorer** | While the IDE is idle, it scans your code and writes per-file docs, a suspected-bug log, and auto-generated tests. |
| 📌 **Long-term memory** | Records lessons from your corrections and project conventions, and saves topic docs to skip re-reading code next time. |

---

## Requirements

1. **VS Code** `^1.106.0` (or a compatible fork).
2. **An OpenAI-compatible LLM endpoint.** Any server that exposes `/v1/chat/completions` (and ideally `/v1/models`) works. Common choices:

   **Ollama** (easiest local option)
   ```bash
   # 1. Install Ollama → https://ollama.com/download
   # 2. Pull a coding model
   ollama pull qwen2.5-coder:7b
   # 3. Make sure the server is running (Ollama exposes an OpenAI-compatible API at /v1)
   ollama serve
   # Endpoint: http://localhost:11434/v1
   ```

   **vLLM**
   ```bash
   python -m vllm.entrypoints.openai.api_server \
     --model Qwen/Qwen2.5-Coder-7B-Instruct
   # Endpoint: http://localhost:8000/v1
   ```

   **LM Studio / llama.cpp / any `/v1` server** — start the server and note its base URL.

> 💡 A model with a large context window (32k+) and strong tool-calling ability gives by far the best agent experience. `qwen2.5-coder` and `deepseek-coder-v2` are good starting points.

---

## Installation

### From a `.vsix` (recommended today)

```powershell
code --install-extension burstcode-0.1.66.vsix
```

Or in VS Code: open the **Extensions** view → `…` menu → **Install from VSIX…** → pick the `.vsix` file.

### Build the `.vsix` yourself

```powershell
npm install
npm run package      # bundles the extension with esbuild
npm run vsix         # produces burstcode-<version>.vsix
```

Then install the generated file with the command above.

---

## Configure your LLM

BurstCode has **two separate profiles** so chat and background work can use different models:

- `burstcode.llm.chat.*` — the model used for the interactive chat agent.
- `burstcode.llm.background.*` — the model used by the Background Code Explorer (or set `burstcode.llm.background.inherit = true` to reuse the chat profile).

The fastest way to get started is the in-product picker:

1. Open the **BurstCode Chat** panel (see [Usage](#usage)).
2. Run **`BurstCode: Configure Model`** or **`BurstCode: Select Active Model`** from the Command Palette (`Ctrl/Cmd+Shift+P`).
3. Enter your base URL (e.g. `http://localhost:11434/v1`) and pick a model. Ids are fetched live from `/v1/models` and merged with any you list manually.

Or edit `settings.json` directly:

```jsonc
{
  // ── Chat profile ───────────────────────────────
  "burstcode.llm.chat.baseURL": "http://localhost:11434/v1",
  "burstcode.llm.chat.apiKey": "",                 // optional for most local servers
  "burstcode.llm.chat.model": "qwen2.5-coder:7b",
  "burstcode.llm.chat.temperature": 0.2,
  "burstcode.llm.chat.contextWindow": 131072,      // total tokens your model supports
  "burstcode.llm.chat.models": [],                 // extra model ids to show in the picker

  // ── Background profile ─────────────────────────
  "burstcode.llm.background.inherit": false,        // true = reuse the chat profile
  "burstcode.llm.background.baseURL": "http://localhost:11434/v1",
  "burstcode.llm.background.model": "qwen2.5-coder:7b"
}
```

> 🔒 Talking to an HTTPS endpoint with a self-signed certificate? Set `burstcode.llm.chat.allowSelfSignedCerts` (and/or the background equivalent) to `true`.

---

## Usage

### Open the chat

BurstCode lives in **two places**:

- The **BurstCode** view container in the Activity Bar (info / quick actions).
- The **BurstCode Chat** webview in the **Secondary Side Bar**.

To open the chat panel, run **`BurstCode: Open Chat`** from the Command Palette, or click the BurstCode icon in the editor title bar / view title bar. Start a fresh conversation any time with **`BurstCode: New Chat`**.

### Talk to the agent

Type a request in plain language, for example:

> *"Add input validation to the login form and write a test for it."*
> *"Why does `parseConfig` throw on empty files? Fix it."*
> *"Rename `fetchUser` to `loadUser` everywhere and update the call sites."*

The agent will:

1. **Locate** the relevant code using semantic tools and batched context collection.
2. **Plan** multi-step work (you'll see a live plan for non-trivial tasks).
3. **Edit** files — changes appear instantly on disk *and* as a staged diff.
4. **Verify** by running your build / tests when appropriate.

### Review changes

Every edit is shown as a diff with inline **Accept** / **Reject** controls per hunk:

- **Accept** keeps the change (it's already on disk).
- **Reject** rolls that hunk back to the original content.
- Use **`BurstCode: Accept All Pending Suggestions`** / **`Reject All Pending Suggestions`** to handle everything at once.

You don't have to wait for the agent — it keeps working while you review asynchronously.

### Roll back a whole turn

BurstCode snapshots a **Git checkpoint** before each agent turn. If a turn went the wrong way, restore it from the chat UI or via **`BurstCode: Restore Git Checkpoint`** — the workspace returns to its pre-turn state.

---

## The agent toolbox

The agent reasons about *which* tool fits each job, and batches independent calls into a single round-trip. Tools fall into four families:

**Context & search**
- `collect_context` — batch reads + greps + dir listings + outlines in one call
- `read_file`, `list_dir`, `grep_search`, `workspace_outline`

**Semantic (LSP-powered)**
- `find_definition`, `find_references` / `find_references_by_name`, `find_implementations`
- `document_symbols`, `workspace_symbols`, `hover_info`, `get_function_range`

**Edits & flow control**
- `propose_edit` (review-first hunks), `write_file` (scratch/scripts)
- `update_plan`, `ask_user`
- `record_lesson` / `forget_lesson`, `save_topic_doc`, `compress_context`

**Execution & web**
- `run_shell` (build / test / lint, with approval gate)
- `launch_subagent` (concurrent isolated read/write agents)
- `web_search`, `read_webpage`

---

## Background Code Explorer

An optional, fully-local background worker. When the IDE is **idle** — no chat run in progress and no recent edits — it picks source files, reads them, and writes analysis to a workspace output directory (`.burstcode/` by default). It automatically pauses while you type or while a chat request is running.

What it produces:

- **`docs/`** — a per-file plain-language summary of what each file does.
- **`bugs.md`** — a log of suspected bugs and risky spots.
- **`tests/`** — auto-generated unit tests for uncertain points.
- **`verifications.md`** — (optional) pass/fail results if you enable test execution.

Enable it with **`BurstCode: Toggle Background Code Explorer`** or set `burstcode.background.enabled = true`. Run a single cycle on demand with **`BurstCode: Run Background Analysis Now`**, and inspect output via **`Show Background Explorer Report`** / **`Show Background Explorer Activity Log`**, or the unified **`Background Explorer Menu`**.

> ⚠️ `burstcode.background.runGeneratedTests` is **off by default** — running auto-generated code touches your shell and dependencies. Review generated tests before enabling it on untrusted projects.

---

## Commands

All commands are available from the Command Palette (`Ctrl/Cmd+Shift+P`).

| Command | Description |
|---|---|
| `BurstCode: Open Chat` | Open the chat panel |
| `BurstCode: New Chat` | Start a fresh conversation |
| `BurstCode: Configure Model` | Set base URL / API key / model interactively |
| `BurstCode: Select Active Model` | Pick the active chat model |
| `BurstCode: Accept All Pending Suggestions` | Accept all queued edits |
| `BurstCode: Reject All Pending Suggestions` | Reject all queued edits |
| `BurstCode: Accept Hunk` / `Reject Hunk` | Per-hunk decisions |
| `BurstCode: Restore Git Checkpoint` | Roll the workspace back to a turn's checkpoint |
| `BurstCode: Toggle Background Code Explorer` | Enable/disable the background worker |
| `BurstCode: Run Background Analysis Now` | Run one background cycle immediately |
| `BurstCode: Select Background Explorer Model` | Pick the background model |
| `BurstCode: Show Background Explorer Report` | View the latest analysis output |
| `BurstCode: Show Background Explorer Activity Log` | View the background activity log |
| `BurstCode: Reset Background Explorer State` | Clear background progress/state |
| `BurstCode: Background Explorer Menu` | Quick-access menu for the above |

---

## Settings reference

### LLM profiles

| Setting | Default | Description |
|---|---|---|
| `burstcode.llm.chat.baseURL` | `http://localhost:11434/v1` | Chat endpoint base URL |
| `burstcode.llm.chat.apiKey` | `""` | API key (optional for local servers) |
| `burstcode.llm.chat.model` | `qwen2.5-coder:7b` | Active chat model id |
| `burstcode.llm.chat.temperature` | `0.2` | Sampling temperature |
| `burstcode.llm.chat.contextWindow` | `131072` | Total context window (tokens) |
| `burstcode.llm.chat.allowSelfSignedCerts` | `false` | Skip TLS verification for the base URL |
| `burstcode.llm.chat.models` | `[]` | Extra model ids shown in the picker |
| `burstcode.llm.background.inherit` | `false` | Reuse the chat profile for background work |
| `burstcode.llm.background.*` | — | Same keys as the chat profile |

### Agent loop

| Setting | Default | Description |
|---|---|---|
| `burstcode.agent.maxIterations` | `512` | Max tool-calling iterations per request |
| `burstcode.agent.requireConfirmBeforeEdit` | `true` | Stage edits for review before finalizing |
| `burstcode.agent.autoContinueOnLength` | `true` | Auto-continue when the model hits the output token limit |
| `burstcode.agent.maxAutoContinues` | `2` | Max consecutive auto-continues |
| `burstcode.agent.autoResumeOnStreamError` | `true` | Retry the turn after a transient stream error |
| `burstcode.agent.maxAutoResumes` | `2` | Max consecutive auto-resumes |
| `burstcode.agent.maxStuckRepeats` | `2` | Identical-turn repeats before escalating to a prompt |
| `burstcode.agent.autoContinueOnPrematureStop` | `true` | Continue when the model stops early without an answer |
| `burstcode.agent.maxPrematureStopContinues` | `2` | Max early-stop continuations |
| `burstcode.agent.subagentMaxIterations` | `64` | Max iterations per sub-agent |
| `burstcode.agent.maxConcurrentSubagents` | `4` | Max concurrent sub-agents per request |
| `burstcode.agent.maxSubagentTasksPerCall` | `8` | Max tasks per `launch_subagent` call |
| `burstcode.agent.enableWriteSubagents` | `true` | Allow sub-agents to edit within scoped files |

### Shell

| Setting | Default | Description |
|---|---|---|
| `burstcode.shell.enabled` | `true` | Allow the `run_shell` tool |
| `burstcode.shell.autoApprove` | `false` | Skip the per-command approval prompt (use with care) |
| `burstcode.shell.defaultTimeoutMs` | `60000` | Default command timeout |

### Background explorer

| Setting | Default | Description |
|---|---|---|
| `burstcode.background.enabled` | `false` | Enable the background worker |
| `burstcode.background.idleThresholdMs` | `10000` | Idle gap before a cycle starts |
| `burstcode.background.minIntervalMs` | `30000` | Minimum gap between cycles |
| `burstcode.background.batchCharBudget` | `120000` | Soft char cap per full-scan batch |
| `burstcode.background.batchMaxFiles` | `25` | Hard file cap per batch |
| `burstcode.background.maxConcurrentTopics` | `10` | Parallel investigation topics per cycle |
| `burstcode.background.includeExtensions` | (many) | File extensions the explorer may read |
| `burstcode.background.maxFileBytes` | `120000` | Skip files larger than this |
| `burstcode.background.outputDir` | `.burstcode` | Where docs/bugs/tests/state are written |
| `burstcode.background.perFileTimeoutMs` | `300000` | Base timeout per background LLM call (4× for batches) |
| `burstcode.background.runGeneratedTests` | `false` | Execute generated tests (touches your shell) |
| `burstcode.background.testRunTimeoutMs` | `60000` | Per-test execution timeout |

### Context & misc

| Setting | Default | Description |
|---|---|---|
| `burstcode.lsp.maxWaitMs` | `60000` | Max wait for a language server to be ready |
| `burstcode.ripgrepPath` | `""` | Explicit path to a `rg` binary (auto-detect if empty) |
| `burstcode.context.outlineBaseDepth` | `2` | Outline recursion depth in the system prompt |
| `burstcode.context.outlineSrcDepth` | `4` | Deeper recursion for source-like dirs |
| `burstcode.context.outlineMaxBytes` | `6000` | Soft cap on the embedded workspace outline |
| `burstcode.context.outlineExtraExcludes` | `[]` | Extra dir names to exclude from the outline |

---

## Building from source

```powershell
npm install          # install dependencies
npm run package      # bundle with esbuild → dist/extension.js
npm run vsix         # produce a .vsix you can install
```

Type-check without emitting:

```powershell
npx tsc --noEmit
```

To iterate, press **F5** in VS Code to launch an Extension Development Host with BurstCode loaded.

---

## Troubleshooting

**The agent can't reach my model.**
Verify the base URL ends with `/v1` and that the server is running (`curl http://localhost:11434/v1/models`). For self-signed HTTPS, enable `allowSelfSignedCerts`.

**`grep_search` reports `spawn rg ENOENT`.**
Set `burstcode.ripgrepPath` to the full path of a `rg` / `rg.exe` binary, then reload the window.

**The model stops mid-task or loops.**
The agent auto-continues and self-corrects, but small models struggle with long tool chains. Try a larger / stronger tool-calling model, and make sure `contextWindow` matches your server's real limit.

**Background explorer never runs.**
It only runs when the IDE is idle. Confirm `burstcode.background.enabled` is `true`, there's no active chat run, and you've been idle past `idleThresholdMs`. Force one cycle with **`Run Background Analysis Now`**.

---

## License

Released under the [MIT License](LICENSE).