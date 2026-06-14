import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  ActoviqAgentDefinition,
  ActoviqPermissionMode,
  ActoviqRunEffort,
} from '../types.js';

interface AgentDefinitionDirectory {
  path: string;
  source: NonNullable<ActoviqAgentDefinition['source']>;
}

export async function loadActoviqAgentDefinitions(options: {
  homeDir: string;
  workDir: string;
  agentDirectories?: string[];
  loadDefaultAgentDirectories?: boolean;
}): Promise<ActoviqAgentDefinition[]> {
  const directories: AgentDefinitionDirectory[] = [];
  if (options.loadDefaultAgentDirectories !== false) {
    directories.push(
      { path: path.join(options.homeDir, 'agents'), source: 'user' },
      { path: path.join(options.workDir, '.actoviq', 'agents'), source: 'project' },
    );
  }
  for (const directory of options.agentDirectories ?? []) {
    directories.push({ path: path.resolve(directory), source: 'custom' });
  }

  const merged = new Map<string, ActoviqAgentDefinition>();
  for (const directory of directories) {
    for (const definition of await loadAgentDirectory(directory)) {
      merged.set(definition.name, definition);
    }
  }
  return [...merged.values()];
}

async function loadAgentDirectory(
  directory: AgentDefinitionDirectory,
): Promise<ActoviqAgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(directory.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const definitions: ActoviqAgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const filePath = path.join(directory.path, entry.name);
    const parsed = parseMarkdownFrontmatter(await readFile(filePath, 'utf8'));
    const definition = createAgentDefinition({
      filePath,
      fallbackName: path.basename(entry.name, path.extname(entry.name)),
      source: directory.source,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
    if (definition) {
      definitions.push(definition);
    } else {
      const fallbackReason =
        !parsed.frontmatter.name?.trim() && !path.basename(entry.name, path.extname(entry.name)).trim()
          ? 'missing name'
          : !parsed.body.trim()
            ? 'empty body'
            : 'missing description';
      console.warn(
        `[actoviq] Skipping agent definition "${path.basename(entry.name)}" in ${directory.path}: ${fallbackReason}. ` +
        'Agent definition files need a name (frontmatter or filename), a description, and a non-empty body.',
      );
    }
  }
  return definitions;
}

function createAgentDefinition(input: {
  filePath: string;
  fallbackName: string;
  source: NonNullable<ActoviqAgentDefinition['source']>;
  frontmatter: Record<string, string>;
  body: string;
}): ActoviqAgentDefinition | undefined {
  const name = input.frontmatter.name?.trim() || input.fallbackName.trim();
  const description =
    input.frontmatter.description?.trim() || extractDescription(input.body);
  if (!name || !description || !input.body.trim()) {
    return undefined;
  }

  const effort = parseEnum(input.frontmatter.effort, ['low', 'medium', 'high', 'max', 'auto']);
  const permissionMode = parseEnum(input.frontmatter.permissionMode, [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'auto',
  ]);
  const memory = parseEnum(input.frontmatter.memory, ['user', 'project', 'local']);
  const isolation = parseEnum(input.frontmatter.isolation, ['worktree']);
  const maxTurns = parsePositiveInteger(
    input.frontmatter.maxTurns ?? input.frontmatter['max-turns'],
  );

  return {
    name,
    description,
    systemPrompt: input.body.trim(),
    model: cleanString(input.frontmatter.model),
    effort: effort as ActoviqRunEffort | undefined,
    permissionMode: permissionMode as ActoviqPermissionMode | undefined,
    maxTurns,
    maxToolIterations: maxTurns,
    allowedTools: parseList(input.frontmatter.tools ?? input.frontmatter.allowedTools),
    disallowedTools: parseList(
      input.frontmatter.disallowedTools ?? input.frontmatter['disallowed-tools'],
    ),
    allowedAgents: parseList(
      input.frontmatter.allowedAgents ?? input.frontmatter['allowed-agents'],
    ),
    skills: parseList(input.frontmatter.skills),
    requiredMcpServers: parseList(
      input.frontmatter.requiredMcpServers ?? input.frontmatter['required-mcp-servers'],
    ),
    initialPrompt: cleanString(
      input.frontmatter.initialPrompt ?? input.frontmatter['initial-prompt'],
    ),
    memory: memory as ActoviqAgentDefinition['memory'],
    background: parseBoolean(input.frontmatter.background),
    isolation: isolation as ActoviqAgentDefinition['isolation'],
    cwd: cleanString(input.frontmatter.cwd),
    allowNestedAgents: parseBoolean(
      input.frontmatter.allowNestedAgents ?? input.frontmatter['allow-nested-agents'],
    ),
    source: input.source,
    sourcePath: input.filePath,
    metadata: {
      source: input.source,
      sourcePath: input.filePath,
    },
  };
}

function parseMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '---') {
      index += 1;
      break;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body: lines.slice(index).join('\n').trim() };
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/^\[/u, '').replace(/\]$/u, '');
  const values = normalized
    .split(/[\n,]/u)
    .map(item => item.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') {
    return undefined;
  }
  return /^(1|true|yes|on)$/iu.test(value.trim());
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const normalized = value?.trim() as T | undefined;
  return normalized && allowed.includes(normalized) ? normalized : undefined;
}

function cleanString(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^['"]|['"]$/gu, '');
  return normalized || undefined;
}

function extractDescription(body: string): string | undefined {
  return body
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => Boolean(line) && !line.startsWith('#'))
    ?.slice(0, 240);
}
