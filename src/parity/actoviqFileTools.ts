import { glob as nodeGlob, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { ToolExecutionError } from '../errors.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';

export interface ActoviqFileToolsOptions {
  cwd?: string;
  maxReadLines?: number;
  defaultGlobLimit?: number;
  defaultGrepLimit?: number;
}

type ReadState = {
  mtimeMs: number;
};

const DEFAULT_MAX_READ_LINES = 2000;
const DEFAULT_GLOB_LIMIT = 100;
const DEFAULT_GREP_LIMIT = 250;
const BINARY_ZERO_BYTE = 0;

export function createActoviqFileTools(
  options: ActoviqFileToolsOptions = {},
): AgentToolDefinition[] {
  const readState = new Map<string, ReadState>();
  const baseCwd = path.resolve(options.cwd ?? process.cwd());
  const maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
  const defaultGlobLimit = options.defaultGlobLimit ?? DEFAULT_GLOB_LIMIT;
  const defaultGrepLimit = options.defaultGrepLimit ?? DEFAULT_GREP_LIMIT;

  const Read = tool(
    {
      name: 'Read',
      description:
        'Read a file from the local filesystem. Returns numbered lines and remembers the file state for later edits.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to read.'),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('1-based starting line number. Omit to start from line 1.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of lines to read. Defaults to ${maxReadLines}.`),
      }),
      serialize: (output: ReadOutput) => output.content,
    },
    async (input, context) => {
      const filePath = requireAbsolutePath(input.file_path);
      const resolvedPath = normalizeAbsolutePath(filePath);
      const fileStats = await stat(resolvedPath);
      if (!fileStats.isFile()) {
        throw new ToolExecutionError('Read', `Path is not a file: ${resolvedPath}`);
      }

      const text = await readTextFile(resolvedPath);
      rememberRead(readState, resolvedPath, fileStats.mtimeMs);

      const lines = text.split(/\r?\n/);
      const startLine = input.offset ?? 1;
      const startIndex = Math.max(0, startLine - 1);
      const lineCount = input.limit ?? maxReadLines;
      const selectedLines = lines.slice(startIndex, startIndex + lineCount);
      const content = formatWithLineNumbers(selectedLines, startIndex + 1);

      return {
        filePath: resolvedPath,
        startLine: startIndex + 1,
        endLine: startIndex + selectedLines.length,
        totalLines: lines.length,
        truncated: startIndex + selectedLines.length < lines.length,
        content,
      } satisfies ReadOutput;
    },
  );

  const Write = tool(
    {
      name: 'Write',
      description:
        'Write a file to the local filesystem. Existing files must be read first to avoid clobbering unseen changes.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to write.'),
        content: z.string().describe('The full file contents to write.'),
      }),
      serialize: (output: WriteOutput) =>
        `${output.type === 'create' ? 'Created' : 'Updated'} ${output.filePath}`,
    },
    async (input) => {
      const resolvedPath = normalizeAbsolutePath(requireAbsolutePath(input.file_path));
      const existing = await safeStat(resolvedPath);
      if (existing?.isFile()) {
        ensurePreviouslyRead(readState, resolvedPath, existing.mtimeMs, 'Write');
      }

      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, 'utf8');
      const finalStats = await stat(resolvedPath);
      rememberRead(readState, resolvedPath, finalStats.mtimeMs);

      return {
        type: existing ? 'update' : 'create',
        filePath: resolvedPath,
        bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      } satisfies WriteOutput;
    },
  );

  const Edit = tool(
    {
      name: 'Edit',
      description:
        'Edit a file in place by replacing one string with another. Existing files must be read first.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to edit.'),
        old_string: z.string().describe('The original text to replace.'),
        new_string: z.string().describe('The replacement text.'),
        replace_all: z.boolean().optional().default(false),
      }),
      serialize: (output: EditOutput) =>
        `Edited ${output.filePath} (${output.replacements} replacement${output.replacements === 1 ? '' : 's'})`,
    },
    async (input) => {
      const resolvedPath = normalizeAbsolutePath(requireAbsolutePath(input.file_path));
      const fileStats = await stat(resolvedPath);
      if (!fileStats.isFile()) {
        throw new ToolExecutionError('Edit', `Path is not a file: ${resolvedPath}`);
      }

      ensurePreviouslyRead(readState, resolvedPath, fileStats.mtimeMs, 'Edit');
      const originalContent = await readTextFile(resolvedPath);
      const occurrences = countOccurrences(originalContent, input.old_string);

      if (occurrences === 0) {
        throw new ToolExecutionError('Edit', `old_string was not found in ${resolvedPath}`);
      }
      if (!input.replace_all && occurrences > 1) {
        throw new ToolExecutionError(
          'Edit',
          `old_string matched ${occurrences} locations in ${resolvedPath}. Use replace_all: true or provide a more specific old_string.`,
        );
      }

      const updatedContent = input.replace_all
        ? originalContent.split(input.old_string).join(input.new_string)
        : replaceFirst(originalContent, input.old_string, input.new_string);

      await writeFile(resolvedPath, updatedContent, 'utf8');
      const finalStats = await stat(resolvedPath);
      rememberRead(readState, resolvedPath, finalStats.mtimeMs);

      return {
        filePath: resolvedPath,
        replacements: input.replace_all ? occurrences : 1,
      } satisfies EditOutput;
    },
  );

  const Glob = tool(
    {
      name: 'Glob',
      description: 'Find files by glob pattern.',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern to match, for example **/*.ts'),
        path: z
          .string()
          .optional()
          .describe('Directory to search in. Defaults to the toolset cwd.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of results. Defaults to ${defaultGlobLimit}.`),
      }),
      serialize: (output: GlobOutput) =>
        output.filenames.length ? output.filenames.join('\n') : 'No files found',
    },
    async (input, context) => {
      const searchRoot = resolveSearchRoot(input.path, context, baseCwd);
      const limit = input.limit ?? defaultGlobLimit;
      const matches: string[] = [];

      for await (const match of nodeGlob(input.pattern, {
        cwd: searchRoot,
        exclude: defaultGlobExcludes,
      })) {
        matches.push(path.resolve(searchRoot, match));
        if (matches.length >= limit) {
          break;
        }
      }

      return {
        root: searchRoot,
        filenames: matches,
        numFiles: matches.length,
      } satisfies GlobOutput;
    },
  );

  const Grep = tool(
    {
      name: 'Grep',
      description:
        'Search file contents with a regular expression. Supports content, files_with_matches, and count output modes.',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression to search for.'),
        path: z
          .string()
          .optional()
          .describe('File or directory to search in. Defaults to the toolset cwd.'),
        glob: z
          .string()
          .optional()
          .describe('Optional glob to narrow the files searched.'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional()
          .default('files_with_matches'),
        head_limit: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(`Result limit. Defaults to ${defaultGrepLimit}. Pass 0 for unlimited.`),
        offset: z.number().int().nonnegative().optional().default(0),
        '-i': z.boolean().optional().default(false),
        '-n': z.boolean().optional().default(true),
        '-A': z.number().int().nonnegative().optional(),
        '-B': z.number().int().nonnegative().optional(),
        '-C': z.number().int().nonnegative().optional(),
        context: z.number().int().nonnegative().optional(),
        multiline: z.boolean().optional().default(false),
      }),
      serialize: (output: GrepOutput) => serializeGrepOutput(output),
    },
    async (input, context) => {
      const searchRoot = resolveSearchRoot(input.path, context, baseCwd);
      const outputMode = input.output_mode ?? 'files_with_matches';
      const limit = input.head_limit ?? defaultGrepLimit;
      const offset = input.offset ?? 0;
      const regex = buildSearchRegex(input.pattern, {
        ignoreCase: input['-i'] ?? false,
        multiline: input.multiline ?? false,
        global: outputMode === 'count',
      });

      const beforeContext = input['-C'] ?? input.context ?? input['-B'] ?? 0;
      const afterContext = input['-C'] ?? input.context ?? input['-A'] ?? 0;

      const matchedFiles: string[] = [];
      const contentLines: string[] = [];
      const countEntries: Array<{ filePath: string; count: number }> = [];
      let totalMatches = 0;

      for await (const absolutePath of iterateSearchFiles(searchRoot, input.glob)) {
        const fileStats = await safeStat(absolutePath);
        if (!fileStats?.isFile()) {
          continue;
        }

        const buffer = await readFile(absolutePath);
        if (isProbablyBinary(buffer)) {
          continue;
        }

        const content = buffer.toString('utf8');
        const relativePath = toDisplayPath(searchRoot, absolutePath);

        if (outputMode === 'files_with_matches') {
          if (buildSearchRegex(input.pattern, {
            ignoreCase: input['-i'] ?? false,
            multiline: input.multiline ?? false,
          }).test(content)) {
            matchedFiles.push(relativePath);
          }
          continue;
        }

        if (outputMode === 'count') {
          const matches = [...content.matchAll(regex)].length;
          if (matches > 0) {
            totalMatches += matches;
            countEntries.push({ filePath: relativePath, count: matches });
          }
          continue;
        }

        const lines = content.split(/\r?\n/);
        const visited = new Set<number>();
        const matcher = buildSearchRegex(input.pattern, {
          ignoreCase: input['-i'] ?? false,
          multiline: false,
        });

        for (let index = 0; index < lines.length; index += 1) {
          if (!matcher.test(lines[index] ?? '')) {
            continue;
          }

          const start = Math.max(0, index - beforeContext);
          const end = Math.min(lines.length - 1, index + afterContext);
          for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
            if (visited.has(lineIndex)) {
              continue;
            }
            visited.add(lineIndex);
            const prefix = input['-n'] === false ? `${relativePath}:` : `${relativePath}:${lineIndex + 1}:`;
            contentLines.push(`${prefix}${lines[lineIndex] ?? ''}`);
          }
        }
      }

      if (outputMode === 'files_with_matches') {
        const paged = applyLimit(matchedFiles, limit, offset);
        return {
          mode: outputMode,
          root: searchRoot,
          filenames: paged.items,
          totalMatches: matchedFiles.length,
          appliedLimit: paged.appliedLimit,
          appliedOffset: offset,
        } satisfies GrepOutput;
      }

      if (outputMode === 'count') {
        const countStrings = countEntries.map((entry) => `${entry.filePath}:${entry.count}`);
        const paged = applyLimit(countStrings, limit, offset);
        return {
          mode: outputMode,
          root: searchRoot,
          filenames: paged.items,
          totalMatches,
          appliedLimit: paged.appliedLimit,
          appliedOffset: offset,
        } satisfies GrepOutput;
      }

      const paged = applyLimit(contentLines, limit, offset);
      return {
        mode: outputMode,
        root: searchRoot,
        filenames: paged.items,
        totalMatches: contentLines.length,
        appliedLimit: paged.appliedLimit,
        appliedOffset: offset,
      } satisfies GrepOutput;
    },
  );

  return [Read, Write, Edit, Glob, Grep];
}

type ReadOutput = {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
};

type WriteOutput = {
  type: 'create' | 'update';
  filePath: string;
  bytesWritten: number;
};

type EditOutput = {
  filePath: string;
  replacements: number;
};

type GlobOutput = {
  root: string;
  filenames: string[];
  numFiles: number;
};

type GrepOutput = {
  mode: 'content' | 'files_with_matches' | 'count';
  root: string;
  filenames: string[];
  totalMatches: number;
  appliedLimit?: number;
  appliedOffset?: number;
};

function requireAbsolutePath(filePath: string): string {
  if (!path.isAbsolute(filePath) && !filePath.startsWith('~')) {
    throw new ToolExecutionError(
      'filesystem',
      `Expected an absolute path, received "${filePath}".`,
    );
  }
  return filePath;
}

function normalizeAbsolutePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.resolve(os.homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

function rememberRead(readState: Map<string, ReadState>, filePath: string, mtimeMs: number): void {
  readState.set(filePath, { mtimeMs });
}

function ensurePreviouslyRead(
  readState: Map<string, ReadState>,
  filePath: string,
  currentMtimeMs: number,
  toolName: 'Write' | 'Edit',
): void {
  const remembered = readState.get(filePath);
  if (!remembered) {
    throw new ToolExecutionError(
      toolName,
      `${toolName} requires the file to be read first: ${filePath}`,
    );
  }
  if (Math.floor(currentMtimeMs) > Math.floor(remembered.mtimeMs)) {
    throw new ToolExecutionError(
      toolName,
      `The file changed after it was last read. Read it again before using ${toolName}: ${filePath}`,
    );
  }
}

async function readTextFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  if (isProbablyBinary(buffer)) {
    throw new ToolExecutionError('Read', `Binary files are not supported by this parity helper: ${filePath}`);
  }
  return buffer.toString('utf8');
}

function formatWithLineNumbers(lines: string[], startLineNumber: number): string {
  if (lines.length === 0) {
    return '';
  }

  return lines
    .map((line, index) => `${String(startLineNumber + index).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return content.split(needle).length - 1;
}

function replaceFirst(content: string, oldValue: string, newValue: string): string {
  const index = content.indexOf(oldValue);
  if (index < 0) {
    return content;
  }
  return `${content.slice(0, index)}${newValue}${content.slice(index + oldValue.length)}`;
}

function resolveSearchRoot(
  inputPath: string | undefined,
  context: ToolExecutionContext,
  fallbackCwd: string,
): string {
  if (!inputPath) {
    return context.cwd || fallbackCwd;
  }
  if (path.isAbsolute(inputPath)) {
    return path.resolve(inputPath);
  }
  return path.resolve(context.cwd || fallbackCwd, inputPath);
}

const defaultGlobExcludes = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.jj/**',
  '**/.sl/**',
];

async function* iterateSearchFiles(
  searchRoot: string,
  globPattern?: string,
): AsyncIterable<string> {
  const pattern = globPattern || '**/*';
  for await (const match of nodeGlob(pattern, {
    cwd: searchRoot,
    exclude: defaultGlobExcludes,
  })) {
    yield path.resolve(searchRoot, match);
  }
}

function buildSearchRegex(
  source: string,
  options: { ignoreCase?: boolean; multiline?: boolean; global?: boolean } = {},
): RegExp {
  const flags = new Set<string>();
  if (options.ignoreCase) {
    flags.add('i');
  }
  if (options.multiline) {
    flags.add('s');
  }
  if (options.global) {
    flags.add('g');
  }
  try {
    return new RegExp(source, [...flags].join(''));
  } catch (error) {
    throw new ToolExecutionError('Grep', `Invalid regular expression "${source}": ${String(error)}`);
  }
}

function applyLimit<T>(items: T[], limit: number | undefined, offset = 0) {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined };
  }
  const effectiveLimit = limit ?? DEFAULT_GREP_LIMIT;
  return {
    items: items.slice(offset, offset + effectiveLimit),
    appliedLimit: items.length - offset > effectiveLimit ? effectiveLimit : undefined,
  };
}

function serializeGrepOutput(output: GrepOutput): string {
  if (output.filenames.length === 0) {
    return 'No matches found';
  }
  return output.filenames.join('\n');
}

function toDisplayPath(searchRoot: string, absolutePath: string): string {
  const relativePath = path.relative(searchRoot, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return absolutePath;
  }
  return relativePath;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 1024);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === BINARY_ZERO_BYTE) {
      return true;
    }
  }
  return false;
}
