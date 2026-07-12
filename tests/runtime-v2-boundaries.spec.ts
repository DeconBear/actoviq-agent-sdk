import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('runtime-v2 dependency boundaries', () => {
  it('keeps core free of Node, product surface, storage, and runtime imports', async () => {
    const directory = path.resolve('src/core');
    const files = (await readdir(directory)).filter(file => file.endsWith('.ts'));
    const source = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8'))))
      .join('\n');

    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/from ['"]\.\.\/(?:runtime|runtime-v2|storage|gui|tui|team|parity|memory)/);
  });

  it('keeps the new state machine independent of product and optional ability modules', async () => {
    const source = await readFile(path.resolve('src/runtime-v2/agentRuntime.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:buddy|dream|team|gui|tui|parity|bridge|memory|actoviqSkills)/i);
    expect(source).not.toContain('createAgentSdk');
    expect(source).not.toContain('process.');
  });
});
