import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PromptTemplate = {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  builtin?: boolean;
};

export const BUILTIN_BEHAVIORAL_GUIDELINES_ID = 'builtin:behavioral-guidelines';

export const BUILTIN_BEHAVIORAL_GUIDELINES_BODY = `Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
<!-- codebase-memory-mcp:start -->
# Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

## Priority Order
1. \`search_graph\` — find functions, classes, routes, variables by pattern
2. \`trace_path\` — trace who calls a function or what it calls
3. \`get_code_snippet\` — read specific function/class source code
4. \`query_graph\` — run Cypher queries for complex patterns
5. \`get_architecture\` — high-level project summary

## When to fall back to grep/glob
- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results

## Examples
- Find a handler: \`search_graph(name_pattern=".*OrderHandler.*")\`
- Who calls it: \`trace_path(function_name="OrderHandler", direction="inbound")\`
- Read source: \`get_code_snippet(qualified_name="pkg/orders.OrderHandler")\`
<!-- codebase-memory-mcp:end -->
`;

export const BUILTIN_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: BUILTIN_BEHAVIORAL_GUIDELINES_ID,
    name: 'Behavioral guidelines',
    body: BUILTIN_BEHAVIORAL_GUIDELINES_BODY,
    createdAt: '1970-01-01T00:00:00.000Z',
    builtin: true,
  },
];

type PromptTemplatesFile = {
  templates: PromptTemplate[];
};

function promptTemplatesPath(homeDir: string): string {
  return path.join(homeDir, 'prompt-templates.json');
}

function normalizeUserTemplate(raw: unknown): PromptTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<PromptTemplate>;
  if (typeof source.id !== 'string' || !source.id.trim()) return null;
  if (source.id.startsWith('builtin:')) return null;
  if (typeof source.name !== 'string' || !source.name.trim()) return null;
  if (typeof source.body !== 'string') return null;
  return {
    id: source.id.trim(),
    name: source.name.trim(),
    body: source.body,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
  };
}

async function readUserTemplates(homeDir: string): Promise<PromptTemplate[]> {
  try {
    const raw = JSON.parse(await readFile(promptTemplatesPath(homeDir), 'utf8')) as unknown;
    const list = (raw as PromptTemplatesFile)?.templates;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeUserTemplate).filter((t): t is PromptTemplate => Boolean(t));
  } catch {
    return [];
  }
}

async function writeUserTemplates(homeDir: string, templates: PromptTemplate[]): Promise<void> {
  const filePath = promptTemplatesPath(homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PromptTemplatesFile = {
    templates: templates.map(({ id, name, body, createdAt }) => ({ id, name, body, createdAt })),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Builtin first, then user templates (newest first). */
export async function listPromptTemplates(homeDir: string): Promise<PromptTemplate[]> {
  const user = await readUserTemplates(homeDir);
  user.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...BUILTIN_PROMPT_TEMPLATES, ...user];
}

export async function createPromptTemplate(
  homeDir: string,
  input: { name: string; body: string },
): Promise<PromptTemplate> {
  const name = input.name.trim();
  const body = input.body;
  if (!name) throw new Error('Template name is required');
  if (!body.trim()) throw new Error('Template body is required');
  const template: PromptTemplate = {
    id: randomUUID(),
    name,
    body,
    createdAt: new Date().toISOString(),
  };
  const current = await readUserTemplates(homeDir);
  current.unshift(template);
  await writeUserTemplates(homeDir, current);
  return template;
}

export async function deletePromptTemplate(homeDir: string, id: string): Promise<boolean> {
  if (!id || id.startsWith('builtin:')) {
    throw new Error('Built-in templates cannot be deleted');
  }
  const current = await readUserTemplates(homeDir);
  const next = current.filter((t) => t.id !== id);
  if (next.length === current.length) return false;
  await writeUserTemplates(homeDir, next);
  return true;
}

export function getBuiltinTemplate(id: string): PromptTemplate | undefined {
  return BUILTIN_PROMPT_TEMPLATES.find((t) => t.id === id);
}
