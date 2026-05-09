/**
 * NotebookEdit tool — matches Claude Code NotebookEditTool schema.
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';

export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit';

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
    },
    async (input) => {
      return { notebook_path: input.notebook_path, cell_id: input.cell_id, edit_mode: input.edit_mode };
    },
  );
}
