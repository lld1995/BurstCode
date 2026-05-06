/**
 * Prompts used by the BackgroundExplorer. Each prompt asks the LLM to return
 * STRICT JSON so we can mechanically merge the result into our on-disk
 * knowledge base (`.quickcode/` by default) without hand-parsing prose.
 */

export const BACKGROUND_SYSTEM_PROMPT = `You are QuickCode's background code-comprehension agent.

You run during the IDE's idle moments. Your goals, in priority order:
  1. Read the given source file carefully.
  2. Produce a concise but accurate Markdown explanation of what the file does
     (responsibilities, public API, data flow, side effects, dependencies).
  3. Flag potential bugs, race conditions, security issues, resource leaks,
     incorrect error handling, off-by-one issues, suspicious type casts, etc.
  4. List points you are NOT confident about ("uncertainties") that would
     benefit from a unit test to verify the behaviour. For each one, write
     a small, self-contained unit test in the file's own language using its
     ecosystem's most common test framework. The test must compile/run
     standalone (include needed imports / setup) and clearly assert the
     specific behaviour you are uncertain about.

Important rules:
  - You must output a SINGLE JSON object, nothing else (no prose, no fences).
  - All fields described in the schema are REQUIRED; use empty arrays / strings
    if you have nothing to report.
  - Be specific. Cite line numbers when reporting bugs. Reference function or
    symbol names when describing behaviour.
  - Do NOT invent symbols or behaviour you cannot see in the snippet.
  - Keep the documentation under ~400 words. Prefer bullet points over prose.
  - If the file is too trivial to analyse (e.g. a re-export barrel, generated
    code, empty file), set "skip": true and return empty arrays for the rest.

Output JSON schema:
{
  "skip": boolean,
  "summary": string,            // one-paragraph elevator pitch for this file
  "doc": string,                // Markdown body (no top-level heading; the caller adds one)
  "bugs": [
    {
      "line": number | null,    // 1-indexed if known
      "severity": "low" | "medium" | "high",
      "title": string,          // short imperative phrase
      "description": string     // why it's wrong + suggested fix
    }
  ],
  "uncertainties": [
    {
      "topic": string,           // what behaviour you are unsure about
      "rationale": string,       // why a test is warranted
      "language": string,        // "typescript" | "javascript" | "python" | "go" | ...
      "framework": string,       // "vitest" | "jest" | "mocha" | "pytest" | "go test" | ...
      "filename": string,        // suggested test file name (no path)
      "test_code": string        // full standalone test source
    }
  ]
}`;

/** Build the user message handed to the LLM for a single file. */
export function buildAnalysisUserMessage(opts: {
  relativePath: string;
  language: string;
  contents: string;
  workspaceOutline?: string;
  /**
   * For TS/JS, the exact relative specifier the generated test file should
   * use to import the module under test (no file extension, forward
   * slashes). Computed by the host so the test resolves once written under
   * `.quickcode/tests/<rel>.d/`.
   */
  importSpecifier?: string;
}): string {
  const outlineBlock = opts.workspaceOutline
    ? `\n\nWorkspace outline (for context, do not analyse other files):\n\`\`\`\n${opts.workspaceOutline}\n\`\`\``
    : '';
  const importHint = opts.importSpecifier
    ? `\n\nIMPORTANT: When generating TypeScript or JavaScript tests, the test file will be saved at \`.quickcode/tests/${opts.relativePath}.d/<your-filename>\`. To import symbols from the file under test you MUST use this specifier exactly:\n\n    import { /* ... */ } from '${opts.importSpecifier}';\n\nDo not invent a different relative path. For Python tests, the test will be run with the workspace root on \`sys.path\`, so use the project's existing module path (e.g. \`from src.foo.bar import ...\`).`
    : '';
  // Number lines so the model can cite them precisely in bug reports.
  const lines = opts.contents.split(/\r?\n/);
  const width = String(lines.length).length;
  const numbered = lines
    .map((l, i) => `${String(i + 1).padStart(width, ' ')}\u2502${l}`)
    .join('\n');
  return `File: ${opts.relativePath}
Language: ${opts.language}${outlineBlock}${importHint}

Source (line-numbered):
\`\`\`${opts.language}
${numbered}
\`\`\`

Analyse this file according to your instructions. Respond with the JSON object only.`;
}

/* ------------------------------------------------------------------ */
/* Topic-driven (agentic) background analysis                          */
/* ------------------------------------------------------------------ */

/**
 * One-shot planner prompt: turns a project outline + a few key files into a
 * concise project brief and an initial backlog of investigation topics. The
 * LLM runs WITHOUT tools here; the host just feeds it outline + selected
 * file contents.
 */
export const BACKGROUND_BRIEF_PROMPT = `You are QuickCode's background project analyst.

You are given a workspace outline and the contents of a few high-signal files
(package.json / README / entry points). Produce:

  1. A concise project brief: what this codebase is, its architecture, the
     main modules, the runtime/build toolchain, and the riskiest areas.
  2. An ordered backlog of "investigation topics" worth analysing in depth
     during idle time. Each topic must be a focused question that benefits
     from reading multiple files together (e.g. "data flow from API
     endpoint X through service Y to storage Z", "concurrency safety of
     module M", "error handling in feature F").

Output strict JSON ONLY (no fences, no prose):
{
  "brief": string,                  // markdown body, < 600 words
  "topics": [
    {
      "id": string,                 // short slug, [a-z0-9-], unique
      "title": string,              // one-line investigation question
      "rationale": string,          // why this matters
      "hints": string[]             // file paths or globs to start from
    }
  ]
}

Rules:
  - Prefer 6–12 topics that each genuinely require multi-file reasoning.
  - Do NOT include trivial topics that fit in a single file.
  - Ground every topic in the outline you were shown — do not invent files.`;

/** Build the user message for the brief/topics planner. */
export function buildBriefUserMessage(opts: {
  workspaceOutline: string;
  keyFiles: Array<{ relPath: string; contents: string }>;
}): string {
  const filesBlock = opts.keyFiles
    .map((f) => {
      // Cap each key file to 8KB so a giant README doesn't blow the prompt.
      const trimmed = f.contents.length > 8000 ? f.contents.slice(0, 8000) + '\n…[truncated]' : f.contents;
      return `File: ${f.relPath}\n\`\`\`\n${trimmed}\n\`\`\``;
    })
    .join('\n\n');
  return `Workspace outline:\n\`\`\`\n${opts.workspaceOutline}\n\`\`\`\n\nKey files:\n\n${filesBlock}\n\nProduce the brief + topics JSON now.`;
}

/**
 * System prompt for the per-topic investigation. The LLM runs WITH read-only
 * tools (read_file / list_dir / grep_search / workspace_outline). It should
 * iteratively pull the files it needs, then emit a final JSON report.
 */
export const BACKGROUND_TOPIC_SYSTEM_PROMPT = `You are QuickCode's background investigator.

You are given a single investigation topic about this workspace. Use the
available read-only tools to read the files you need. You may grep, list
directories, and read targeted line ranges. Pull as many files as the topic
truly requires — there is no hard file count limit. The host will compress
older context automatically if needed, so prefer fresh, targeted reads over
dumping whole files.

When you have enough evidence, finish your turn by emitting a SINGLE JSON
object as the assistant message, with NO surrounding prose and NO code fences.
The object must follow this schema:

{
  "skip": boolean,
  "summary": string,
  "doc": string,
  "files_examined": string[],
  "bugs": [
    {
      "file": string,
      "line": number | null,
      "severity": "low" | "medium" | "high",
      "title": string,
      "description": string
    }
  ],
  "uncertainties": [
    {
      "topic": string,
      "rationale": string,
      "language": string,
      "framework": string,
      "filename": string,
      "test_code": string
    }
  ]
}

Rules:
  - Cite specific files and line numbers when reporting bugs.
  - Tests must be self-contained, in the file's own language and ecosystem.
  - If after exploration the topic is moot, set "skip": true and return empty
    arrays for the rest. Still include the files you read in files_examined.
  - Never edit files. The tools you have are READ-ONLY.`;

/** Build the user message handed to the per-topic investigator. */
export function buildTopicUserMessage(opts: {
  topicId: string;
  topicTitle: string;
  topicRationale: string;
  topicHints: string[];
  brief: string;
}): string {
  const hintsBlock = opts.topicHints.length
    ? `\nStarting hints (paths or globs):\n${opts.topicHints.map((h) => `  - ${h}`).join('\n')}`
    : '';
  return `Project brief (for context):
\`\`\`
${opts.brief}
\`\`\`

Investigation topic: ${opts.topicTitle}
Topic id: ${opts.topicId}
Why it matters: ${opts.topicRationale}${hintsBlock}

Investigate this topic now using the read-only tools, then emit the final
JSON report as your last assistant message.`;
}
