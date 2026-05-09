/**
 * Prompts used by the BackgroundExplorer. Each prompt asks the LLM to return
 * STRICT JSON so we can mechanically merge the result into our on-disk
 * knowledge base (`.burstcode/` by default) without hand-parsing prose.
 *
 * Two prompts are used per cycle:
 *   1. `BACKGROUND_BATCH_PROMPT` — the full-scan pass: every candidate source
 *      file is read in batches, documented, and surfaces multi-file topics.
 *   2. `BACKGROUND_TOPIC_SYSTEM_PROMPT` — the topic investigation pass: each
 *      pending topic is handed to a read-only AgentLoop that pulls additional
 *      files via tools and produces a focused report + tests.
 */

/* ------------------------------------------------------------------ */
/* Topic-driven (agentic) background analysis                          */
/* ------------------------------------------------------------------ */

/**
 * System prompt for the per-topic investigation. The LLM runs WITH read-only
 * tools (read_file / list_dir / grep_search / workspace_outline). It should
 * iteratively pull the files it needs, then emit a final JSON report.
 */
export const BACKGROUND_TOPIC_SYSTEM_PROMPT = `You are BurstCode's background investigator.

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

/* ------------------------------------------------------------------ */
/* Batched full-scan planner                                           */
/* ------------------------------------------------------------------ */

/**
 * System prompt for the batched full-scan pass. The host enumerates ALL
 * source files in the workspace (modulo size / extension filters), groups
 * them into batches sized to fit the model's context window, and hands each
 * batch to a single LLM call. The model is expected to:
 *
 *   1. Read every file in the batch carefully.
 *   2. Emit a per-file documentation entry (`file_docs[]`).
 *   3. Propose any NEW multi-file investigation topics observed in this
 *      batch (`topics[]`). Topics already in the existing backlog (the host
 *      passes their titles in the user message) must NOT be repeated.
 *   4. Emit a one- or two-sentence batch summary for the project brief
 *      aggregator.
 *
 * The model has NO tools — only the file contents in the user message.
 * It must NOT invent files it was not shown.
 */
export const BACKGROUND_BATCH_PROMPT = `You are BurstCode's background project analyst.

You are given the FULL contents of a batch of source files from a single
workspace. Your job is to (a) document each file and (b) surface any
multi-file investigation topics that this batch makes obvious.

Output strict JSON ONLY (no fences, no prose):
{
  "file_docs": [
    {
      "path": string,         // must match an input file path EXACTLY
      "summary": string,      // one-paragraph elevator pitch (<= 60 words)
      "doc": string           // markdown body, < 400 words; bullets preferred
    }
  ],
  "topics": [
    {
      "id": string,           // short slug, [a-z0-9-], unique within this reply
      "title": string,        // one-line investigation question
      "rationale": string,    // why it matters
      "hints": string[]       // file paths or globs to start from
    }
  ],
  "batch_summary": string     // 1-2 sentences for the project brief
}

Rules:
  - Document EVERY file in the batch — one entry per input file, in any order.
  - Ground the documentation in what you can actually see. Do not invent
    APIs, types, or behaviours.
  - Topics must require READING MULTIPLE FILES TOGETHER (data flow, error
    paths, concurrency, security boundaries, integration seams, etc.). Skip
    anything that fits in a single file.
  - Do NOT repeat any topic whose title is already listed in the
    "Existing topic backlog" section of the user message.
  - Prefer 0–4 NEW topics per batch; emit an empty array if nothing new.
  - "path" in file_docs MUST exactly match one of the workspace-relative
    paths given in the user message (forward slashes).`;

/**
 * Build the user message for the batched full-scan pass. `files` is the
 * batch contents; `existingTopicTitles` is the running backlog so the model
 * can avoid duplicates.
 */
export function buildBatchUserMessage(opts: {
  files: Array<{ relPath: string; language: string; contents: string }>;
  existingTopicTitles: string[];
  batchIndex: number;
  batchTotal: number;
}): string {
  const filesBlock = opts.files
    .map((f) => {
      const lines = f.contents.split(/\r?\n/);
      const width = String(lines.length).length;
      const numbered = lines
        .map((l, i) => `${String(i + 1).padStart(width, ' ')}\u2502${l}`)
        .join('\n');
      return `File: ${f.relPath}\nLanguage: ${f.language}\n\`\`\`${f.language}\n${numbered}\n\`\`\``;
    })
    .join('\n\n');
  const backlogBlock = opts.existingTopicTitles.length
    ? `Existing topic backlog (do NOT propose duplicates of these):\n${opts.existingTopicTitles.map((t) => `  - ${t}`).join('\n')}\n\n`
    : 'Existing topic backlog: (empty)\n\n';
  return `Batch ${opts.batchIndex + 1} of ${opts.batchTotal} — ${opts.files.length} file${opts.files.length === 1 ? '' : 's'}.

${backlogBlock}Files in this batch:

${filesBlock}

Produce the file_docs + topics + batch_summary JSON now. Document every file above.`;
}

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
