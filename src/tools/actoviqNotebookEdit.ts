import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { ToolExecutionError } from '../errors.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit';

type NotebookCell = {
  id?: string;
  cell_type?: 'code' | 'markdown' | string;
  source?: unknown;
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
};

type NotebookDocument = {
  cells?: NotebookCell[];
  [key: string]: unknown;
};

export function createNotebookEditTool(): AgentToolDefinition {
  return tool(
    {
      name: NOTEBOOK_EDIT_TOOL_NAME,
      description:
        'Edit a Jupyter notebook (.ipynb file) cell. Supports editing source, changing cell type, ' +
        'and inserting new cells.',
      inputSchema: z.strictObject({
        notebook_path: z.string().describe(
          'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
        ),
        cell_id: z.string().optional().describe(
          'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
        ),
        new_source: z.string().describe('The new source for the cell'),
        cell_type: z.enum(['code', 'markdown']).optional().describe(
          'The type of the cell (code or markdown). If not specified, defaults to current cell type. If using edit_mode=insert, this is required.',
        ),
        edit_mode: z.enum(['replace', 'insert']).optional().default('replace').describe(
          'replace: modify an existing cell. insert: add a new cell after cell_id.',
        ),
      }),
      isDestructive: () => true,
    },
    async (input) => {
      const notebookPath = resolveNotebookPath(input.notebook_path);
      const notebook = await readNotebook(notebookPath);
      const mode = input.edit_mode ?? 'replace';

      if (!Array.isArray(notebook.cells)) {
        throw new ToolExecutionError(
          NOTEBOOK_EDIT_TOOL_NAME,
          `Notebook does not contain a cells array: ${notebookPath}`,
        );
      }

      if (mode === 'insert') {
        if (!input.cell_type) {
          throw new ToolExecutionError(
            NOTEBOOK_EDIT_TOOL_NAME,
            'cell_type is required when edit_mode is "insert".',
          );
        }
        const insertIndex = input.cell_id
          ? findCellIndex(notebook.cells, input.cell_id, notebookPath) + 1
          : 0;
        const cell = createNotebookCell(input.cell_type, input.new_source);
        notebook.cells.splice(insertIndex, 0, cell);
        await writeNotebook(notebookPath, notebook);
        return {
          notebook_path: notebookPath,
          edit_mode: mode,
          cell_id: cell.id,
          cell_type: cell.cell_type,
          index: insertIndex,
        };
      }

      if (!input.cell_id) {
        throw new ToolExecutionError(
          NOTEBOOK_EDIT_TOOL_NAME,
          'cell_id is required when edit_mode is "replace".',
        );
      }

      const index = findCellIndex(notebook.cells, input.cell_id, notebookPath);
      const existing = notebook.cells[index]!;
      const nextType = input.cell_type ?? normalizeCellType(existing.cell_type);
      notebook.cells[index] = normalizeCellForType(
        {
          ...existing,
          cell_type: nextType,
          source: input.new_source,
        },
        nextType,
      );
      await writeNotebook(notebookPath, notebook);
      return {
        notebook_path: notebookPath,
        edit_mode: mode,
        cell_id: input.cell_id,
        cell_type: nextType,
        index,
      };
    },
  );
}

function resolveNotebookPath(rawPath: string): string {
  if (!path.isAbsolute(rawPath) && !rawPath.startsWith('~')) {
    throw new ToolExecutionError(
      NOTEBOOK_EDIT_TOOL_NAME,
      `Expected an absolute notebook_path, received "${rawPath}".`,
    );
  }
  const resolved =
    rawPath === '~'
      ? os.homedir()
      : rawPath.startsWith('~/') || rawPath.startsWith('~\\')
        ? path.resolve(os.homedir(), rawPath.slice(2))
        : path.resolve(rawPath);
  if (!resolved.toLowerCase().endsWith('.ipynb')) {
    throw new ToolExecutionError(
      NOTEBOOK_EDIT_TOOL_NAME,
      `NotebookEdit only supports .ipynb files: ${resolved}`,
    );
  }
  return resolved;
}

async function readNotebook(notebookPath: string): Promise<NotebookDocument> {
  let raw: string;
  try {
    raw = await readFile(notebookPath, 'utf8');
  } catch {
    throw new ToolExecutionError(
      NOTEBOOK_EDIT_TOOL_NAME,
      `Notebook not found: ${notebookPath}`,
    );
  }

  try {
    const parsed = JSON.parse(raw) as NotebookDocument;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Notebook root must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolExecutionError(
      NOTEBOOK_EDIT_TOOL_NAME,
      `Failed to parse notebook JSON at ${notebookPath}: ${message}`,
    );
  }
}

async function writeNotebook(notebookPath: string, notebook: NotebookDocument): Promise<void> {
  await writeFile(notebookPath, `${JSON.stringify(notebook, null, 2)}\n`, 'utf8');
}

function findCellIndex(cells: NotebookCell[], cellId: string, notebookPath: string): number {
  const index = cells.findIndex(cell => cell.id === cellId);
  if (index < 0) {
    throw new ToolExecutionError(
      NOTEBOOK_EDIT_TOOL_NAME,
      `Cell "${cellId}" was not found in ${notebookPath}.`,
    );
  }
  return index;
}

function createNotebookCell(cellType: 'code' | 'markdown', source: string): NotebookCell {
  return normalizeCellForType(
    {
      id: randomUUID().replace(/-/gu, '').slice(0, 16),
      cell_type: cellType,
      metadata: {},
      source,
    },
    cellType,
  );
}

function normalizeCellType(value: NotebookCell['cell_type']): 'code' | 'markdown' {
  return value === 'markdown' ? 'markdown' : 'code';
}

function normalizeCellForType(cell: NotebookCell, cellType: 'code' | 'markdown'): NotebookCell {
  if (cellType === 'code') {
    return {
      ...cell,
      cell_type: 'code',
      outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
      execution_count:
        typeof cell.execution_count === 'number' || cell.execution_count === null
          ? cell.execution_count
          : null,
    };
  }

  const { outputs: _outputs, execution_count: _executionCount, ...rest } = cell;
  return {
    ...rest,
    cell_type: 'markdown',
  };
}
