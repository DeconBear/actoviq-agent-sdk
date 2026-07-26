import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createActoviqBridgeSdk } from '../src/index.js';

const reasonixCliPath = path.resolve(
  process.cwd(),
  'tests',
  'fixtures',
  'fake-reasonix-cli.mjs',
);
const crushCliPath = path.resolve(
  process.cwd(),
  'tests',
  'fixtures',
  'fake-crush-cli.mjs',
);

describe('managed external CLI option enforcement', () => {
  it('fails closed when Reasonix cannot enforce generic bridge options', async () => {
    const sdk = await createActoviqBridgeSdk({
      directCli: true,
      directCliProvider: 'reasonix',
      executable: process.execPath,
      cliPath: reasonixCliPath,
      workDir: process.cwd(),
    });
    try {
      await expect(sdk.run('must-not-spawn', {
        systemPrompt: 'unsupported prompt',
        tools: [],
      })).rejects.toThrow(
        /Reasonix managed mode cannot enforce bridge options: systemPrompt, tools/u,
      );
    } finally {
      await sdk.close();
    }
  });

  it('fails closed when Crush cannot enforce generic or effort options', async () => {
    const sdk = await createActoviqBridgeSdk({
      directCli: true,
      directCliProvider: 'crush',
      executable: process.execPath,
      cliPath: crushCliPath,
      workDir: process.cwd(),
      trustProjectResources: true,
    });
    try {
      await expect(sdk.run('must-not-spawn', {
        maxTurns: 3,
        effort: 'high',
      })).rejects.toThrow(
        /Crush managed mode cannot enforce bridge options: maxTurns, effort/u,
      );
    } finally {
      await sdk.close();
    }
  });
});
