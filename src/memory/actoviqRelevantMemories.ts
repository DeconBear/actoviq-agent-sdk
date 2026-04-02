import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

import type {
  ActoviqMemoryFileHeader,
  ActoviqRelevantMemory,
  ActoviqSurfacedMemory,
} from '../types.js';

const FRONTMATTER_MAX_LINES = 30;
const MAX_MEMORY_FILES = 200;
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4_096;
const DEFAULT_RELEVANT_MEMORY_LIMIT = 5;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 3);
}

function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') {
    return {};
  }

  const frontmatter: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '---') {
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
  return frontmatter;
}

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async entry => {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }
        if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
          results.push(fullPath);
        }
      }),
    );
  }

  await visit(rootDir);
  return results;
}

async function readHeader(filePath: string, scope: 'private' | 'team'): Promise<ActoviqMemoryFileHeader | null> {
  try {
    const [content, metadata] = await Promise.all([
      readFile(filePath, 'utf8'),
      stat(filePath),
    ]);
    const headerSlice = content.split(/\r?\n/u).slice(0, FRONTMATTER_MAX_LINES).join('\n');
    const frontmatter = parseFrontmatter(headerSlice);
    return {
      filename: path.relative(scope === 'private' ? path.dirname(filePath) : path.dirname(filePath), filePath),
      filePath,
      mtimeMs: metadata.mtimeMs,
      description: frontmatter.description ?? null,
      type: frontmatter.type,
      scope,
    };
  } catch {
    return null;
  }
}

function formatSearchCorpus(memory: ActoviqMemoryFileHeader): string {
  return [
    memory.filename,
    memory.description ?? '',
    memory.type ?? '',
    memory.scope,
  ]
    .join(' ')
    .toLowerCase();
}

function shouldPenalizeToolReference(
  memory: ActoviqMemoryFileHeader,
  recentTools: readonly string[],
): boolean {
  if (recentTools.length === 0) {
    return false;
  }

  const corpus = formatSearchCorpus(memory);
  const referencesTool = recentTools.some(tool => corpus.includes(tool.toLowerCase()));
  if (!referencesTool) {
    return false;
  }

  return /\b(reference|usage|api|docs|documentation)\b/u.test(corpus);
}

function scoreMemory(
  query: string,
  memory: ActoviqMemoryFileHeader,
  recentTools: readonly string[],
): number {
  if (shouldPenalizeToolReference(memory, recentTools)) {
    return -100;
  }

  const loweredQuery = query.toLowerCase();
  const corpus = formatSearchCorpus(memory);
  const tokens = tokenize(query);
  let score = 0;

  if (corpus.includes(loweredQuery) && loweredQuery.length >= 4) {
    score += 8;
  }

  for (const token of tokens) {
    if (memory.filename.toLowerCase().includes(token)) {
      score += 4;
    }
    if ((memory.description ?? '').toLowerCase().includes(token)) {
      score += 3;
    }
    if ((memory.type ?? '').toLowerCase().includes(token)) {
      score += 2;
    }
  }

  const ageDays = Math.max(0, Math.floor((Date.now() - memory.mtimeMs) / 86_400_000));
  score += Math.max(0, 3 - Math.min(ageDays, 3));

  return score;
}

function truncateMemoryContent(content: string, filePath: string): { content: string; limit?: number } {
  const lines = content.split(/\r?\n/u);
  const truncatedByLines = lines.length > MAX_MEMORY_LINES;
  const slicedLines = truncatedByLines ? lines.slice(0, MAX_MEMORY_LINES) : lines;
  let truncated = slicedLines.join('\n');
  let truncatedByBytes = false;

  if (Buffer.byteLength(truncated, 'utf8') > MAX_MEMORY_BYTES) {
    truncatedByBytes = true;
    while (Buffer.byteLength(truncated, 'utf8') > MAX_MEMORY_BYTES && truncated.length > 0) {
      const lastBreak = truncated.lastIndexOf('\n');
      truncated = truncated.slice(0, lastBreak > 0 ? lastBreak : Math.max(0, truncated.length - 1));
    }
  }

  if (!truncatedByLines && !truncatedByBytes) {
    return {
      content,
    };
  }

  return {
    content:
      truncated +
      `\n\n> This memory file was truncated (${truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Read the full file at: ${filePath}`,
    limit: truncatedByLines ? MAX_MEMORY_LINES : undefined,
  };
}

export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days === 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  return `${days} days ago`;
}

export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 1) {
    return '';
  }
  return `This memory is ${days} days old. Memories are point-in-time observations, so verify against current code or state before asserting them as fact.`;
}

export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  return text ? `<system-reminder>${text}</system-reminder>\n` : '';
}

export function memoryHeader(filePath: string, mtimeMs: number): string {
  const freshness = memoryFreshnessText(mtimeMs);
  return freshness
    ? `${freshness}\n\nMemory: ${filePath}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${filePath}:`;
}

export async function scanMemoryFiles(
  memoryDir: string,
  scope: 'private' | 'team',
): Promise<ActoviqMemoryFileHeader[]> {
  const files = await walkMarkdownFiles(memoryDir);
  const headers = await Promise.all(files.map(filePath => readHeader(filePath, scope)));
  return headers
    .filter((header): header is ActoviqMemoryFileHeader => header !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
    .map(header => ({
      ...header,
      filename: path.relative(memoryDir, header.filePath),
    }));
}

export function formatMemoryManifest(memories: ActoviqMemoryFileHeader[]): string {
  return memories
    .map(memory => {
      const tag = memory.type ? `[${memory.type}] ` : '';
      const timestamp = new Date(memory.mtimeMs).toISOString();
      return memory.description
        ? `- ${tag}${memory.filename} (${timestamp}): ${memory.description}`
        : `- ${tag}${memory.filename} (${timestamp})`;
    })
    .join('\n');
}

export function selectRelevantMemories(
  query: string,
  memories: ActoviqMemoryFileHeader[],
  options: {
    recentTools?: readonly string[];
    alreadySurfacedPaths?: ReadonlySet<string>;
    limit?: number;
  } = {},
): ActoviqRelevantMemory[] {
  const recentTools = options.recentTools ?? [];
  const alreadySurfacedPaths = options.alreadySurfacedPaths ?? new Set<string>();
  const limit = options.limit ?? DEFAULT_RELEVANT_MEMORY_LIMIT;

  return memories
    .filter(memory => !alreadySurfacedPaths.has(memory.filePath))
    .map(memory => ({
      filename: memory.filename,
      path: memory.filePath,
      mtimeMs: memory.mtimeMs,
      description: memory.description,
      type: memory.type,
      scope: memory.scope,
      score: scoreMemory(query, memory, recentTools),
    }))
    .filter(memory => (memory.score ?? 0) > 0)
    .sort((left, right) => {
      if ((right.score ?? 0) !== (left.score ?? 0)) {
        return (right.score ?? 0) - (left.score ?? 0);
      }
      return right.mtimeMs - left.mtimeMs;
    })
    .slice(0, limit);
}

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<ActoviqRelevantMemory>,
): Promise<ActoviqSurfacedMemory[]> {
  const surfaced: Array<ActoviqSurfacedMemory | null> = await Promise.all(
    selected.map(async memory => {
      try {
        const raw = await readFile(memory.path, 'utf8');
        const truncated = truncateMemoryContent(raw, memory.path);
        return {
          path: memory.path,
          content: truncated.content,
          mtimeMs: memory.mtimeMs,
          header: memoryHeader(memory.path, memory.mtimeMs),
          limit: truncated.limit,
          scope: memory.scope,
          freshnessText: memoryFreshnessText(memory.mtimeMs) || undefined,
        } satisfies ActoviqSurfacedMemory;
      } catch {
        return null;
      }
    }),
  );

  return surfaced.filter((memory): memory is ActoviqSurfacedMemory => memory !== null);
}
