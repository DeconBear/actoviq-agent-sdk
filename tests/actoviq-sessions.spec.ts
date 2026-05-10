import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getProjectDir } from '../src/parity/portableSessions.js';
import {
  getActoviqBridgeSessionInfo,
  getActoviqBridgeSessionMessages,
  listActoviqBridgeSessions,
} from '../src/index.js';

const tempDirs: string[] = [];
const LEGACY_CONFIG_ENV_KEY = ['CL', 'AUDE_CONFIG_DIR'].join('');
const originalActoviqConfigDir = process.env.ACTOVIQ_CONFIG_DIR;
const originalLegacyConfigDir = process.env[LEGACY_CONFIG_ENV_KEY];

afterEach(async () => {
  process.env.ACTOVIQ_CONFIG_DIR = originalActoviqConfigDir;
  if (originalLegacyConfigDir == null) {
    delete process.env[LEGACY_CONFIG_ENV_KEY];
  } else {
    process.env[LEGACY_CONFIG_ENV_KEY] = originalLegacyConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('Actoviq Runtime session parity helpers', () => {
  it('lists Actoviq Runtime native sessions from the portable project store', async () => {
    const actoviqConfigDir = await createTempDir('actoviq-runtime-config-');
    const projectDir = await createTempDir('actoviq-project-');
    process.env.ACTOVIQ_CONFIG_DIR = actoviqConfigDir;
    process.env[LEGACY_CONFIG_ENV_KEY] = actoviqConfigDir;

    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const sessionFile = path.join(getProjectDir(projectDir), `${sessionId}.jsonl`);

    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-01T08:00:00.000Z',
          cwd: projectDir,
          message: {
            content: 'Remember the Sparrow migration project.',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await listActoviqBridgeSessions({
      dir: projectDir,
      includeWorktrees: false,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(sessionId);
    expect(sessions[0]?.summary).toContain('Sparrow migration project');
    expect(sessions[0]?.cwd).toBe(projectDir);
  });

  it('reads Actoviq Runtime native session info and reconstructs the latest conversation chain', async () => {
    const actoviqConfigDir = await createTempDir('actoviq-runtime-config-');
    const projectDir = await createTempDir('actoviq-project-');
    process.env.ACTOVIQ_CONFIG_DIR = actoviqConfigDir;
    process.env[LEGACY_CONFIG_ENV_KEY] = actoviqConfigDir;

    const sessionId = '99999999-1111-2222-3333-444444444444';
    const sessionFile = path.join(getProjectDir(projectDir), `${sessionId}.jsonl`);

    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId,
          timestamp: '2026-04-01T08:00:00.000Z',
        }),
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: 'user',
          uuid: '11111111-1111-1111-1111-111111111111',
          timestamp: '2026-04-01T08:00:01.000Z',
          cwd: projectDir,
          sessionId,
          message: { role: 'user', content: 'First question' },
        }),
        JSON.stringify({
          parentUuid: '11111111-1111-1111-1111-111111111111',
          isSidechain: false,
          type: 'assistant',
          uuid: '22222222-2222-2222-2222-222222222222',
          timestamp: '2026-04-01T08:00:02.000Z',
          cwd: projectDir,
          sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'First answer' }],
          },
        }),
        JSON.stringify({
          parentUuid: '22222222-2222-2222-2222-222222222222',
          isSidechain: false,
          type: 'user',
          uuid: '33333333-3333-3333-3333-333333333333',
          timestamp: '2026-04-01T08:00:03.000Z',
          cwd: projectDir,
          sessionId,
          message: { role: 'user', content: 'Second question' },
        }),
        JSON.stringify({
          parentUuid: '33333333-3333-3333-3333-333333333333',
          isSidechain: false,
          type: 'assistant',
          uuid: '44444444-4444-4444-4444-444444444444',
          timestamp: '2026-04-01T08:00:04.000Z',
          cwd: projectDir,
          sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Second answer' }],
          },
        }),
        JSON.stringify({
          parentUuid: null,
          isSidechain: true,
          type: 'assistant',
          uuid: '55555555-5555-5555-5555-555555555555',
          timestamp: '2026-04-01T08:00:05.000Z',
          cwd: projectDir,
          sessionId,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Sidechain answer' }],
          },
        }),
        JSON.stringify({
          type: 'last-prompt',
          sessionId,
          lastPrompt: 'Second question',
        }),
      ].join('\n'),
      'utf8',
    );

    const info = await getActoviqBridgeSessionInfo(sessionId, { dir: projectDir });
    const messages = await getActoviqBridgeSessionMessages(sessionId, { dir: projectDir });

    expect(info?.sessionId).toBe(sessionId);
    expect(info?.summary).toBe('Second question');
    expect(messages.map((message) => message.uuid)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);
  });
});
