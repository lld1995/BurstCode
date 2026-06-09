import * as vscode from 'vscode';
import * as path from 'path';

export const GLOBAL_RULES_RELATIVE_PATH = '.burstcode/rules.md';
export const GLOBAL_SKILLS_RELATIVE_PATH = '.burstcode/skills';
export const GLOBAL_SKILLS_INDEX_RELATIVE_PATH = '.burstcode/skills/README.md';

const DEFAULT_GLOBAL_RULES = `# BurstCode global rules

Write project-wide requirements for the BurstCode agent here.
These rules are injected into every agent run for this workspace.

Examples:
- Always answer in Chinese.
- Do not modify generated files.
- Run \`npx tsc --noEmit\` before reporting TypeScript changes as complete.
`;

const DEFAULT_GLOBAL_SKILLS_INDEX = `# BurstCode skills

Create one skill per Markdown file in this folder. BurstCode reads this folder before each agent run and injects only the skills that appear relevant to the user's current request.

Suggested layout:
- \`packaging-vsix.md\`
- \`typescript-verification.md\`
- \`release-checklist.md\`

Suggested skill file format:
\`\`\`md
# VSIX packaging

Use when the user asks to package, build, or publish a VSIX.

Steps:
1. Run \`powershell -File scripts/pack.ps1\`.
2. Report the generated .vsix path and size.
\`\`\`
`;

export interface WorkspacePromptFileRender {
  text: string;
  truncated: boolean;
}

export type GlobalRulesRender = WorkspacePromptFileRender;
export type GlobalSkillsRender = WorkspacePromptFileRender;

interface SkillCandidate {
  relativePath: string;
  text: string;
  truncated: boolean;
  score: number;
}

function promptFileUri(root: string, relativePath: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, relativePath));
}

async function readWorkspacePromptFile(
  root: string,
  relativePath: string,
  truncationLabel: string,
  maxChars: number
): Promise<WorkspacePromptFileRender | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(promptFileUri(root, relativePath));
    const raw = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').trim();
    if (!raw) return undefined;
    if (raw.length <= maxChars) return { text: raw, truncated: false };
    return {
      text: `${raw.slice(0, maxChars).trimEnd()}\n\n(... ${truncationLabel} truncated)`,
      truncated: true
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'FileNotFound') return undefined;
    throw err;
  }
}

async function ensureWorkspacePromptFile(root: string, relativePath: string, defaultContent: string): Promise<vscode.Uri> {
  const uri = promptFileUri(root, relativePath);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'FileNotFound') throw err;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(defaultContent, 'utf8'));
  }
  return uri;
}

async function openWorkspacePromptFile(root: string, relativePath: string, defaultContent: string): Promise<void> {
  const uri = await ensureWorkspacePromptFile(root, relativePath, defaultContent);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

function skillsDirUri(root: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, GLOBAL_SKILLS_RELATIVE_PATH));
}

const SKILL_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'user', 'asks',
  'file', 'files', 'code', 'fix', 'add', 'edit', 'update', 'change', 'readme'
]);
const MAX_SKILL_FILE_BYTES = 512 * 1024;

function tokenSet(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) {
    const token = m[0];
    if (!SKILL_STOP_WORDS.has(token)) out.add(token);
  }
  const cjk = [...lower.matchAll(/[\p{Script=Han}]/gu)].map((m) => m[0]);
  for (let i = 0; i < cjk.length - 1; i++) out.add(`${cjk[i]}${cjk[i + 1]}`);
  return out;
}

function skillKeywordSet(taskText: string): Set<string> {
  return tokenSet(taskText);
}

function skillMetadata(text: string): string {
  const lines = text.split(/\r?\n/);
  const titleLines = lines.filter((line) => /^\s*#{1,3}\s+/.test(line)).slice(0, 3);
  const useWhenLines = lines.filter((line) => /^\s*(use when|when to use|适用|使用场景)\b/i.test(line));
  return [...titleLines, ...useWhenLines].join('\n');
}

function scoreSkill(taskText: string, relativePath: string, text: string): number {
  const keywords = skillKeywordSet(taskText);
  let score = /(^|[\\/])(always|global)\.(md|txt)$/i.test(relativePath) ? 2 : 0;
  if (keywords.size === 0) return score;

  const pathTokens = tokenSet(relativePath);
  const metadataTokens = tokenSet(`${relativePath}\n${skillMetadata(text)}`);
  const bodyTokens = tokenSet(text);
  for (const kw of keywords) {
    if (pathTokens.has(kw)) score += 4;
    else if (metadataTokens.has(kw)) score += 3;
    else if (bodyTokens.has(kw)) score += 1;
  }
  return score;
}

async function collectSkillFiles(root: string, dir: vscode.Uri, depth = 2): Promise<Array<{ uri: vscode.Uri; relativePath: string }>> {
  const entries = (await vscode.workspace.fs.readDirectory(dir)).sort(([a], [b]) => a.localeCompare(b));
  const files: Array<{ uri: vscode.Uri; relativePath: string }> = [];
  for (const [name, type] of entries) {
    if (name.startsWith('.')) continue;
    const uri = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.Directory && depth > 0) {
      files.push(...await collectSkillFiles(root, uri, depth - 1));
      continue;
    }
    if (type !== vscode.FileType.File || !/\.(md|txt)$/i.test(name)) continue;
    files.push({ uri, relativePath: path.relative(root, uri.fsPath).replace(/\\/g, '/') });
  }
  return files;
}

export async function readGlobalRules(root: string, maxChars = 12000): Promise<GlobalRulesRender | undefined> {
  return readWorkspacePromptFile(root, GLOBAL_RULES_RELATIVE_PATH, 'global rules', maxChars);
}

export async function ensureGlobalRulesFile(root: string): Promise<vscode.Uri> {
  return ensureWorkspacePromptFile(root, GLOBAL_RULES_RELATIVE_PATH, DEFAULT_GLOBAL_RULES);
}

export async function openGlobalRulesFile(root: string): Promise<void> {
  await openWorkspacePromptFile(root, GLOBAL_RULES_RELATIVE_PATH, DEFAULT_GLOBAL_RULES);
}

export async function readGlobalSkills(
  root: string,
  taskText: string,
  maxChars = 16000,
  maxSkills = 6
): Promise<GlobalSkillsRender | undefined> {
  let files: Array<{ uri: vscode.Uri; relativePath: string }>;
  try {
    files = await collectSkillFiles(root, skillsDirUri(root));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'FileNotFound') return undefined;
    throw err;
  }

  const candidates: SkillCandidate[] = [];
  for (const file of files) {
    // README documents the folder and is never injected as a task skill.
    if (/README\.md$/i.test(file.relativePath)) continue;
    const stat = await vscode.workspace.fs.stat(file.uri);
    if (stat.size > MAX_SKILL_FILE_BYTES) continue;
    const bytes = await vscode.workspace.fs.readFile(file.uri);
    const raw = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '').trim();
    if (!raw) continue;
    const score = scoreSkill(taskText, file.relativePath, raw);
    if (score <= 0) continue;
    candidates.push({ relativePath: file.relativePath, text: raw, truncated: false, score });
  }

  const selected = candidates
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, maxSkills);
  if (selected.length === 0) return undefined;

  let remaining = maxChars;
  let truncated = false;
  const blocks: string[] = [];
  for (const skill of selected) {
    const header = `--- skill: ${skill.relativePath} ---\n`;
    const separatorLength = blocks.length === 0 ? 0 : 2;
    const budget = remaining - separatorLength - header.length;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let body = skill.text;
    if (body.length > budget) {
      const suffix = '\n\n(... skill truncated)';
      body = `${body.slice(0, Math.max(0, budget - suffix.length)).trimEnd()}${suffix}`;
      if (body.length > budget) body = body.slice(0, budget);
      truncated = true;
    }
    const block = `${header}${body}`;
    blocks.push(block);
    remaining -= separatorLength + block.length;
  }

  const text = blocks.join('\n\n');
  return { text: text.length <= maxChars ? text : text.slice(0, maxChars), truncated: truncated || text.length > maxChars };
}

export async function ensureGlobalSkillsDirectory(root: string): Promise<vscode.Uri> {
  const dir = skillsDirUri(root);
  await vscode.workspace.fs.createDirectory(dir);
  await ensureWorkspacePromptFile(root, GLOBAL_SKILLS_INDEX_RELATIVE_PATH, DEFAULT_GLOBAL_SKILLS_INDEX);
  return dir;
}

export async function openGlobalSkillsDirectory(root: string): Promise<void> {
  const dir = await ensureGlobalSkillsDirectory(root);
  const indexUri = promptFileUri(root, GLOBAL_SKILLS_INDEX_RELATIVE_PATH);
  const doc = await vscode.workspace.openTextDocument(indexUri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('revealInExplorer', dir);
}
