import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ToolExecutionError } from '../src/errors.js';
import { createActoviqFileTools } from '../src/index.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createContext(cwd: string): ToolExecutionContext {
  return {
    runId: 'run-test',
    cwd,
    metadata: {},
    prompt: 'test prompt',
    iteration: 1,
  };
}

function getTool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

describe('Actoviq Runtime parity file tools', () => {
  it('reads, edits, and writes files with upstream-style read-before-write safeguards', async () => {
    const cwd = await createTempDir('actoviq-parity-tools-');
    const filePath = path.join(cwd, 'sample.txt');
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

    const tools = createActoviqFileTools({ cwd });
    const context = createContext(cwd);
    const Read = getTool(tools, 'Read');
    const Edit = getTool(tools, 'Edit');
    const Write = getTool(tools, 'Write');

    const readResult = await Read.execute(
      { file_path: filePath, offset: 2, limit: 2 },
      context,
    );
    expect(readResult).toMatchObject({
      filePath,
      startLine: 2,
      endLine: 3,
      totalLines: 4,
    });
    expect((readResult as { content: string }).content).toContain('2\tbeta');

    const editResult = await Edit.execute(
      {
        file_path: filePath,
        old_string: 'beta',
        new_string: 'delta',
        replace_all: false,
      },
      context,
    );
    expect(editResult).toMatchObject({
      filePath,
      replacements: 1,
    });
    expect(await readFile(filePath, 'utf8')).toContain('delta');

    const updatedStats = await stat(filePath);
    const overwriteResult = await Write.execute(
      {
        file_path: filePath,
        content: 'rewritten\n',
      },
      context,
    );
    expect(overwriteResult).toMatchObject({
      type: 'update',
      filePath,
    });
    expect(await readFile(filePath, 'utf8')).toBe('rewritten\n');
    expect((await stat(filePath)).mtimeMs).toBeGreaterThanOrEqual(updatedStats.mtimeMs);
  });

  it('rejects writing an existing file that has not been read first', async () => {
    const cwd = await createTempDir('actoviq-parity-tools-');
    const filePath = path.join(cwd, 'guarded.txt');
    await writeFile(filePath, 'original\n', 'utf8');

    const tools = createActoviqFileTools({ cwd });
    const context = createContext(cwd);
    const Write = getTool(tools, 'Write');

    await expect(
      Write.execute(
        {
          file_path: filePath,
          content: 'new content\n',
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it('finds files and searches contents with Glob and Grep', async () => {
    const cwd = await createTempDir('actoviq-parity-tools-');
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(path.join(cwd, 'src', 'one.ts'), 'export const alpha = 1;\n', 'utf8');
    await writeFile(path.join(cwd, 'src', 'two.ts'), 'export const beta = 2;\n', 'utf8');
    await writeFile(path.join(cwd, 'README.md'), '# demo\n', 'utf8');

    const tools = createActoviqFileTools({ cwd });
    const context = createContext(cwd);
    const Glob = getTool(tools, 'Glob');
    const Grep = getTool(tools, 'Grep');

    const globResult = await Glob.execute(
      {
        pattern: 'src/**/*.ts',
      },
      context,
    );
    expect((globResult as { filenames: string[] }).filenames).toHaveLength(2);

    const grepResult = await Grep.execute(
      {
        pattern: 'alpha|beta',
        path: cwd,
        glob: 'src/**/*.ts',
        output_mode: 'content',
      },
      context,
    );
    expect((grepResult as { filenames: string[] }).filenames.join('\n')).toContain('one.ts:1:export const alpha = 1;');
    expect((grepResult as { filenames: string[] }).filenames.join('\n')).toContain('two.ts:1:export const beta = 2;');
  });
});
