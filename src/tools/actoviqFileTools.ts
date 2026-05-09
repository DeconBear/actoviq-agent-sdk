/**
 * Actoviq File Tools — Read, Write, Edit, Glob, Grep
 *
 * Schemas, descriptions, and prompts match Claude Code exactly.
 * Execution logic is adapted for the Actoviq SDK environment.
 */
import { readFile, writeFile, mkdir, stat as fsStat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glob } from 'glob';
import { z } from 'zod';

import { ToolExecutionError } from '../errors.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';
import { fileReadPrompt, FILE_READ_TOOL_NAME } from './prompts/fileReadPrompt.js';
import { fileWritePrompt, FILE_WRITE_TOOL_NAME } from './prompts/fileWritePrompt.js';
import { fileEditPrompt, FILE_EDIT_TOOL_NAME } from './prompts/fileEditPrompt.js';
import { fileSearchPrompt } from './prompts/fileSearchPrompt.js';

export interface ActoviqFileToolsOptions {
  cwd?: string;
  maxReadLines?: number;
  defaultGlobLimit?: number;
  defaultGrepLimit?: number;
}

const DEFAULT_MAX_READ_LINES = 2000;
const DEFAULT_GLOB_LIMIT = 100;
const DEFAULT_GREP_LIMIT = 250;
const BINARY_ZERO_BYTE = 0;
const PDF_MAX_PAGES = 20;

// ── Read tool (matches Claude Code FileReadTool) ─────────────────

type ReadState = Map<string, { mtimeMs: number }>;

const Read = (opts: { cwd: string; maxReadLines: number; readState: ReadState }) =>
  tool(
    {
      name: FILE_READ_TOOL_NAME,
      description:
        'Reads a file from the local filesystem. You can access any file directly by using this tool.\n' +
        'Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid.\n\n' +
        'Usage:\n' +
        '- The file_path parameter must be an absolute path, not a relative path\n' +
        `- By default, it reads up to ${opts.maxReadLines} lines starting from the beginning of the file\n` +
        '- When you already know which part of the file you need, only read that part.\n' +
        '- Results are returned using cat -n format, with line numbers starting at 1\n' +
        '- This tool can read images (PNG, JPG, etc) and PDF files (.pdf)\n' +
        '- This tool can read Jupyter notebooks (.ipynb files) and returns all cells\n' +
        '- This tool can only read files, not directories.\n' +
        '- You will regularly be asked to read screenshots. ALWAYS use this tool to view the file at the path.\n' +
        '- If you read a file that exists but has empty contents you will receive a system reminder.',
      inputSchema: z.strictObject({
        file_path: z.string().describe('The absolute path to the file to read'),
        offset: z.number().int().nonnegative().optional().describe(
          'The line number to start reading from. Only provide if the file is too large to read at once',
        ),
        limit: z.number().int().positive().optional().describe(
          'The number of lines to read. Only provide if the file is too large to read at once.',
        ),
        pages: z.string().optional().describe(
          `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES} pages per request.`,
        ),
      }),
      isReadOnly: () => true,
      prompt: fileReadPrompt,
    },
    async (input) => {
      const resolvedPath = resolvePath(input.file_path, opts.cwd);
      let fileStats;
      try { fileStats = await fsStat(resolvedPath); } catch {
        throw new ToolExecutionError('Read', `File not found: ${resolvedPath}`);
      }
      if (!fileStats.isFile()) {
        throw new ToolExecutionError('Read', `Path is not a file: ${resolvedPath}`);
      }

      // Handle PDF
      if (resolvedPath.toLowerCase().endsWith('.pdf') && input.pages) {
        throw new ToolExecutionError('Read', 'PDF reading requires pdf-parse dependency. Install it to read PDFs.');
      }

      const buffer = await readFile(resolvedPath);
      if (isProbablyBinary(buffer) && !isImagePath(resolvedPath) && !isPDFPath(resolvedPath)) {
        throw new ToolExecutionError('Read', `Cannot read binary file: ${resolvedPath}`);
      }

      const text = buffer.toString('utf-8');
      opts.readState.set(resolvedPath, { mtimeMs: fileStats.mtimeMs });

      const lines = text.split(/\r?\n/);
      const startLine = input.offset ?? 1;
      const startIndex = Math.max(0, startLine - 1);
      const lineCount = input.limit ?? opts.maxReadLines;
      const selected = lines.slice(startIndex, startIndex + lineCount);
      const content = selected.map((l, i) => `${String(startLine + i).padStart(6, ' ')}\t${l}`).join('\n');

      return {
        type: 'text',
        file: {
          filePath: resolvedPath,
          content,
          numLines: selected.length,
          startLine,
          totalLines: lines.length,
        },
      };
    },
  );

// ── Write tool (matches Claude Code FileWriteTool) ───────────────

const Write = (opts: { cwd: string; readState: ReadState }) =>
  tool(
    {
      name: FILE_WRITE_TOOL_NAME,
      description:
        'Writes a file to the local filesystem.\n\n' +
        'Usage:\n' +
        '- This tool will overwrite the existing file if there is one at the provided path.\n' +
        `- If this is an existing file, you MUST use the \`${FILE_READ_TOOL_NAME}\` tool first to read the file's contents.\n` +
        '- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n' +
        '- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n' +
        '- Only use emojis if the user explicitly requests it.',
      inputSchema: z.strictObject({
        file_path: z.string().describe('The absolute path to the file to write (must be absolute, not relative)'),
        content: z.string().describe('The content to write to the file'),
      }),
      isDestructive: () => true,
      prompt: fileWritePrompt,
    },
    async (input) => {
      const resolvedPath = resolvePath(input.file_path, opts.cwd);
      let existing;
      try { existing = await fsStat(resolvedPath); } catch { /* new file */ }

      if (existing?.isFile()) {
        ensurePreviouslyRead(opts.readState, resolvedPath, existing.mtimeMs, 'Write');
      }

      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, 'utf-8');
      const finalStats = await fsStat(resolvedPath);
      opts.readState.set(resolvedPath, { mtimeMs: finalStats.mtimeMs });

      return {
        type: existing ? 'update' : 'create',
        filePath: resolvedPath,
        content: input.content,
      };
    },
  );

// ── Edit tool (matches Claude Code FileEditTool) ─────────────────

const Edit = (opts: { cwd: string; readState: ReadState }) =>
  tool(
    {
      name: FILE_EDIT_TOOL_NAME,
      description:
        'Performs exact string replacements in files.\n\n' +
        'Usage:\n' +
        `- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n` +
        '- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match.\n' +
        '- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n' +
        '- Only use emojis if the user explicitly requests it.\n' +
        '- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n' +
        '- Use `replace_all` for replacing and renaming strings across the file.',
      inputSchema: z.strictObject({
        file_path: z.string().describe('The absolute path to the file to modify'),
        old_string: z.string().describe('The text to replace'),
        new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
        replace_all: z.boolean().optional().default(false),
      }),
      isDestructive: () => true,
      prompt: fileEditPrompt,
    },
    async (input) => {
      const resolvedPath = resolvePath(input.file_path, opts.cwd);
      let fileStats;
      try { fileStats = await fsStat(resolvedPath); } catch {
        throw new ToolExecutionError('Edit', `File not found: ${resolvedPath}`);
      }
      if (!fileStats.isFile()) {
        throw new ToolExecutionError('Edit', `Path is not a file: ${resolvedPath}`);
      }

      ensurePreviouslyRead(opts.readState, resolvedPath, fileStats.mtimeMs, 'Edit');
      const originalContent = await readFile(resolvedPath, 'utf-8');
      const occurrences = (originalContent.match(new RegExp(escapeRegex(input.old_string), 'g')) || []).length;

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
        : originalContent.replace(input.old_string, input.new_string);

      await writeFile(resolvedPath, updatedContent, 'utf-8');
      const finalStats = await fsStat(resolvedPath);
      opts.readState.set(resolvedPath, { mtimeMs: finalStats.mtimeMs });

      return {
        filePath: resolvedPath,
        replacements: input.replace_all ? occurrences : 1,
      };
    },
  );

// ── Glob tool (matches Claude Code GlobTool) ─────────────────────

const GLOB_TOOL_NAME = 'Glob';
const defaultGlobExcludes = ['**/.git/**', '**/node_modules/**', '**/.svn/**', '**/.hg/**', '**/.jj/**', '**/.sl/**'];

const Glob = (opts: { cwd: string; defaultGlobLimit: number }) =>
  tool(
    {
      name: GLOB_TOOL_NAME,
      description:
        '- Fast file pattern matching tool that works with any codebase size\n' +
        '- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
        '- Returns matching file paths sorted by modification time\n' +
        '- Use this tool when you need to find files by name patterns\n' +
        '- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead',
      inputSchema: z.strictObject({
        pattern: z.string().describe('The glob pattern to match files against'),
        path: z.string().optional().describe('The directory to search in. Defaults to the current working directory.'),
        limit: z.number().int().positive().optional().describe(`Maximum number of results. Defaults to ${opts.defaultGlobLimit}.`),
      }),
      isReadOnly: () => true,
      prompt: fileSearchPrompt,
    },
    async (input) => {
      const searchRoot = resolvePath(input.path ?? opts.cwd, opts.cwd);
      const matches: string[] = [];
      const stream = glob.stream(input.pattern, {
        cwd: searchRoot, absolute: true, nodir: true, ignore: defaultGlobExcludes, windowsPathsNoEscape: true,
      });
      for await (const match of stream) {
        if (typeof match === 'string') matches.push(match);
        if (matches.length >= (input.limit ?? opts.defaultGlobLimit)) break;
      }
      return {
        root: searchRoot,
        filenames: matches.slice(0, input.limit ?? opts.defaultGlobLimit),
        numFiles: matches.length,
      };
    },
  );

// ── Grep tool (matches Claude Code GrepTool) ─────────────────────

const GREP_TOOL_NAME = 'Grep';

const Grep = (opts: { cwd: string; defaultGrepLimit: number }) =>
  tool(
    {
      name: GREP_TOOL_NAME,
      description:
        'A powerful search tool built on ripgrep\n\n' +
        'Usage:\n' +
        '- ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command.\n' +
        '- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n' +
        '- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")\n' +
        '- Output modes: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts\n' +
        '- Use Agent tool for open-ended searches requiring multiple rounds\n' +
        '- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping\n' +
        '- Multiline matching: By default patterns match within single lines only. For cross-line patterns use `multiline: true`',
      inputSchema: z.strictObject({
        pattern: z.string().describe('The regular expression pattern to search for in file contents'),
        path: z.string().optional().describe('File or directory to search in. Defaults to current working directory.'),
        glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().default('files_with_matches'),
        head_limit: z.number().int().nonnegative().optional().describe(`Output limit. Defaults to ${opts.defaultGrepLimit}. Pass 0 for unlimited.`),
        offset: z.number().int().nonnegative().optional().default(0),
        '-i': z.boolean().optional().default(false),
        '-n': z.boolean().optional().default(true),
        '-A': z.number().int().nonnegative().optional(),
        '-B': z.number().int().nonnegative().optional(),
        '-C': z.number().int().nonnegative().optional(),
        context: z.number().int().nonnegative().optional(),
        multiline: z.boolean().optional().default(false),
      }),
      isReadOnly: () => true,
      prompt: fileSearchPrompt,
    },
    async (input) => {
      const searchRoot = resolvePath(input.path ?? opts.cwd, opts.cwd);
      const outputMode = input.output_mode ?? 'files_with_matches';
      const limit = input.head_limit ?? opts.defaultGrepLimit;
      const ignoreCase = input['-i'] ?? false;
      const multiline = input.multiline ?? false;

      const matchedFiles: string[] = [];
      const contentLines: string[] = [];
      const countEntries: Array<{ file: string; count: number }> = [];
      let totalMatches = 0;
      const before = input['-C'] ?? input.context ?? input['-B'] ?? 0;
      const after = input['-C'] ?? input.context ?? input['-A'] ?? 0;

      function buildRegex(pattern: string, global = false): RegExp {
        const f = [ignoreCase ? 'i' : '', multiline ? 's' : '', global ? 'g' : ''].filter(Boolean).join('');
        return new RegExp(pattern, f);
      }

      const files = await findFiles(searchRoot, input.glob);
      for (const f of files) {
        try {
          const buffer = await readFile(f);
          if (isProbablyBinary(buffer)) continue;
          const content = buffer.toString('utf-8');
          const relPath = path.relative(searchRoot, f) || f;

          if (outputMode === 'files_with_matches') {
            if (buildRegex(input.pattern).test(content)) matchedFiles.push(relPath);
          } else if (outputMode === 'count') {
            const count = [...content.matchAll(buildRegex(input.pattern, true))].length;
            if (count > 0) { totalMatches += count; countEntries.push({ file: relPath, count }); }
          } else {
            const lines = content.split(/\r?\n/);
            const visited = new Set<number>();
            for (let i = 0; i < lines.length; i++) {
              if (!buildRegex(input.pattern).test(lines[i]!)) continue;
              for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) {
                if (visited.has(j)) continue;
                visited.add(j);
                contentLines.push(input['-n'] === false ? `${relPath}:${lines[j]}` : `${relPath}:${j + 1}:${lines[j]}`);
              }
            }
          }
        } catch { /* skip unreadable files */ }
      }

      const off = input.offset ?? 0;
      if (outputMode === 'files_with_matches') {
        const sliced = limit === 0 ? matchedFiles.slice(off) : matchedFiles.slice(off, off + limit);
        return { mode: outputMode, root: searchRoot, filenames: sliced, totalMatches: matchedFiles.length };
      }
      if (outputMode === 'count') {
        const entries = countEntries.map(e => `${e.file}:${e.count}`);
        const sliced = limit === 0 ? entries.slice(off) : entries.slice(off, off + limit);
        return { mode: outputMode, root: searchRoot, filenames: sliced, totalMatches };
      }
      const sliced = limit === 0 ? contentLines.slice(off) : contentLines.slice(off, off + limit);
      return { mode: outputMode, root: searchRoot, filenames: sliced, totalMatches: contentLines.length };
    },
  );

// ── Factory ─────────────────────────────────────────────────────

export function createActoviqFileTools(
  options: ActoviqFileToolsOptions = {},
): AgentToolDefinition[] {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maxReadLines = options.maxReadLines ?? DEFAULT_MAX_READ_LINES;
  const defaultGlobLimit = options.defaultGlobLimit ?? DEFAULT_GLOB_LIMIT;
  const defaultGrepLimit = options.defaultGrepLimit ?? DEFAULT_GREP_LIMIT;
  const readState: ReadState = new Map();

  return [
    Read({ cwd, maxReadLines, readState }),
    Write({ cwd, readState }),
    Edit({ cwd, readState }),
    Glob({ cwd, defaultGlobLimit }),
    Grep({ cwd, defaultGrepLimit }),
  ];
}

// ── Helpers ─────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd: string): string {
  if (filePath.startsWith('~')) {
    return path.resolve(os.homedir(), filePath.slice(1));
  }
  if (!path.isAbsolute(filePath)) {
    throw new ToolExecutionError('filesystem', `Expected an absolute path, received "${filePath}".`);
  }
  return path.resolve(filePath);
}

function ensurePreviouslyRead(
  readState: ReadState,
  filePath: string,
  mtimeMs: number,
  toolName: 'Write' | 'Edit',
): void {
  const remembered = readState.get(filePath);
  if (!remembered) {
    throw new ToolExecutionError(toolName, `${toolName} requires the file to be read first: ${filePath}`);
  }
  if (Math.floor(mtimeMs) > Math.floor(remembered.mtimeMs)) {
    throw new ToolExecutionError(
      toolName,
      `The file changed after it was last read. Read it again before using ${toolName}: ${filePath}`,
    );
  }
}

async function findFiles(searchRoot: string, globPattern?: string): Promise<string[]> {
  if (!globPattern) return listAllFiles(searchRoot);
  return listGlobMatches(globPattern, searchRoot);
}

async function listGlobMatches(pattern: string, root: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const m of glob.stream(pattern, { cwd: root, absolute: true, nodir: true, ignore: defaultGlobExcludes, windowsPathsNoEscape: true })) {
    if (typeof m === 'string') matches.push(m);
  }
  return matches;
}

async function listAllFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    for (const entry of await readdirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        results.push(...await listAllFiles(full));
      } else {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

async function readdirSafe(dir: string): Promise<{ name: string; isDirectory: () => boolean }[]> {
  const fs = await import('node:fs/promises');
  try {
    return (await fs.readdir(dir, { withFileTypes: true })) as any;
  } catch { return []; }
}

function isProbablyBinary(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
    if (buffer[i] === BINARY_ZERO_BYTE) return true;
  }
  return false;
}

function isImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath);
}

function isPDFPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
