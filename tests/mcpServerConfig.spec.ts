import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addMcpServer,
  readMcpServerConfig,
  removeMcpServer,
  writeMcpServerConfig,
  getMcpConfigPath,
} from '../src/mcp/mcpServerConfig.js';

const tempHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(h => rm(h, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const h = await mkdtemp(path.join(os.tmpdir(), 'mcp-home-'));
  tempHomes.push(h);
  return h;
}

describe('mcpServerConfig', () => {
  it('reads empty config when no file exists', async () => {
    const home = await makeHome();
    expect(readMcpServerConfig(home)).toEqual({ servers: [] });
  });

  it('writes then reads a server list round-trip', async () => {
    const home = await makeHome();
    writeMcpServerConfig({ servers: [
      { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      { name: 'gh', command: 'gh-mcp' },
    ] }, home);
    const read = readMcpServerConfig(home);
    expect(read.servers).toHaveLength(2);
    expect(read.servers[0]).toMatchObject({ name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] });
  });

  it('addMcpServer adds and dedupes by name', async () => {
    const home = await makeHome();
    addMcpServer({ name: 'fs', command: 'old-cmd' }, home);
    addMcpServer({ name: 'fs', command: 'new-cmd', args: ['-x'] }, home);
    const read = readMcpServerConfig(home);
    expect(read.servers).toHaveLength(1);
    expect(read.servers[0]?.command).toBe('new-cmd');
    expect(read.servers[0]?.args).toEqual(['-x']);
  });

  it('removeMcpServer deletes by name', async () => {
    const home = await makeHome();
    addMcpServer({ name: 'a', command: 'c1' }, home);
    addMcpServer({ name: 'b', command: 'c2' }, home);
    removeMcpServer('a', home);
    const read = readMcpServerConfig(home);
    expect(read.servers).toHaveLength(1);
    expect(read.servers[0]?.name).toBe('b');
  });

  it('ignores malformed entries gracefully', async () => {
    const home = await makeHome();
    writeMcpServerConfig({ servers: [
      { name: 'ok', command: 'c' },
      { name: 'no-command' } as never,
      { command: 'no-name' } as never,
    ] }, home);
    const read = readMcpServerConfig(home);
    expect(read.servers).toHaveLength(1);
    expect(read.servers[0]?.name).toBe('ok');
  });

  it('getMcpConfigPath points under ~/.actoviq/mcp.json', () => {
    expect(getMcpConfigPath('/home/user')).toBe(path.join('/home/user', '.actoviq', 'mcp.json'));
  });
});
