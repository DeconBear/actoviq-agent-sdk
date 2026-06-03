import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBashTool, createNotebookEditTool, createPowerShellTool } from '../src/index.js';
import type { ToolExecutionContext } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
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

describe('PowerShell tool', () => {
  it('executes a PowerShell command on Windows', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const cwd = await createTempDir('actoviq-powershell-tool-');
    const tool = createPowerShellTool();
    const result = await tool.execute(
      { command: "Write-Output 'actoviq-ok'" },
      createContext(cwd),
    ) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('actoviq-ok');
    expect(result.stderr).toBe('');
  });
});

describe('Bash tool', () => {
  it('executes commands in the tool context cwd', async () => {
    const cwd = await createTempDir('actoviq-bash-tool-');
    const tool = createBashTool();
    const result = await tool.execute(
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log(process.cwd())')}`,
      },
      createContext(cwd),
    ) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(path.normalize(result.stdout.trim())).toBe(path.normalize(cwd));
  });
});

describe('NotebookEdit tool', () => {
  it('replaces and inserts notebook cells', async () => {
    const cwd = await createTempDir('actoviq-notebook-tool-');
    const notebookPath = path.join(cwd, 'demo.ipynb');
    await writeFile(
      notebookPath,
      `${JSON.stringify(
        {
          cells: [
            {
              id: 'cell-1',
              cell_type: 'code',
              metadata: {},
              source: 'print("old")',
              outputs: [],
              execution_count: null,
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const tool = createNotebookEditTool();
    const context = createContext(cwd);

    const replaceResult = await tool.execute(
      {
        notebook_path: notebookPath,
        cell_id: 'cell-1',
        new_source: 'print("new")',
      },
      context,
    ) as { index: number; cell_type: string };

    const insertResult = await tool.execute(
      {
        notebook_path: notebookPath,
        cell_id: 'cell-1',
        edit_mode: 'insert',
        cell_type: 'markdown',
        new_source: '# Notes',
      },
      context,
    ) as { index: number; cell_type: string; cell_id: string };

    const updated = JSON.parse(await readFile(notebookPath, 'utf8')) as {
      cells: Array<{ id?: string; cell_type: string; source: string }>;
    };

    expect(replaceResult).toMatchObject({ index: 0, cell_type: 'code' });
    expect(insertResult).toMatchObject({ index: 1, cell_type: 'markdown' });
    expect(updated.cells[0]).toMatchObject({ id: 'cell-1', source: 'print("new")' });
    expect(updated.cells[1]).toMatchObject({ id: insertResult.cell_id, source: '# Notes' });
  });
});
