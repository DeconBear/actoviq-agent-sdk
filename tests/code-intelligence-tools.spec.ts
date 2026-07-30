import { describe, expect, it, vi } from 'vitest';

import { createCodeIntelligenceTools } from '../src/codeIntel/codeIntelligenceTools.js';

describe('code intelligence tools', () => {
  it('exposes four read-only semantic queries', async () => {
    const service = {
      workspaceSymbols: vi.fn(async () => []),
      definition: vi.fn(async () => []),
      references: vi.fn(async () => []),
      diagnostics: vi.fn(async () => []),
    };
    const tools = createCodeIntelligenceTools(service as never);
    expect(tools.map(tool => tool.name)).toEqual([
      'FindSymbol',
      'GoToDefinition',
      'FindReferences',
      'GetDiagnostics',
    ]);
    expect(tools.every(tool => tool.isReadOnly?.({}) === true)).toBe(true);
    await tools[0]!.execute({ query: 'name' }, {} as never);
    expect(service.workspaceSymbols).toHaveBeenCalledWith('name');
  });
});
