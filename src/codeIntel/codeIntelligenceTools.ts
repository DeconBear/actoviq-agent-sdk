import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { CodeIntelligenceService } from './codeIntelligenceService.js';

const positionSchema = {
  filePath: z.string().min(1),
  line: z.number().int().nonnegative().describe('Zero-based line number.'),
  character: z.number().int().nonnegative().default(0).describe('Zero-based character offset.'),
};

export function createCodeIntelligenceTools(
  service: CodeIntelligenceService,
): AgentToolDefinition[] {
  return [
    tool(
      {
        name: 'FindSymbol',
        description: 'Search configured language servers for workspace symbols before falling back to text search.',
        inputSchema: z.strictObject({ query: z.string().min(1) }),
        isReadOnly: () => true,
      },
      input => service.workspaceSymbols(input.query),
    ),
    tool(
      {
        name: 'GoToDefinition',
        description: 'Resolve the definition for a symbol at a source position.',
        inputSchema: z.strictObject(positionSchema),
        isReadOnly: () => true,
      },
      input => service.definition(input.filePath, input.line, input.character),
    ),
    tool(
      {
        name: 'FindReferences',
        description: 'Find semantic references for a symbol at a source position.',
        inputSchema: z.strictObject(positionSchema),
        isReadOnly: () => true,
      },
      input => service.references(input.filePath, input.line, input.character),
    ),
    tool(
      {
        name: 'GetDiagnostics',
        description: 'Read diagnostics published by configured language servers.',
        inputSchema: z.strictObject({ filePath: z.string().optional() }),
        isReadOnly: () => true,
      },
      input => service.diagnostics(input.filePath),
    ),
  ];
}
