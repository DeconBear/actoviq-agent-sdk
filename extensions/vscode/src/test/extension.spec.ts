import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeAppServerMessage,
  encodeAppServerRequest,
} from '../appServerProtocol.js';

describe('VS Code/Cursor app-server client', () => {
  it('encodes requests and recognizes streamed notifications and responses', () => {
    const request = JSON.parse(encodeAppServerRequest(
      'vscode-1',
      'session/send',
      { sessionId: 'session-1', input: 'hello' },
    ));
    expect(request).toEqual({
      version: 1,
      id: 'vscode-1',
      method: 'session/send',
      params: { sessionId: 'session-1', input: 'hello' },
    });
    expect(decodeAppServerMessage(JSON.stringify({
      version: 1,
      type: 'event',
      method: 'session/event',
      params: {
        sessionId: 'session-1',
        event: { type: 'response.text.delta', delta: 'hello' },
      },
    }))).toMatchObject({
      type: 'event',
      method: 'session/event',
      params: { sessionId: 'session-1' },
    });
    expect(decodeAppServerMessage('not json')).toBeUndefined();
  });

  it('declares native diff, checkpoint, goal, and session-restore commands', async () => {
    const packageJson = JSON.parse(await readFile(
      path.resolve(process.cwd(), 'package.json'),
      'utf8',
    )) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect(packageJson.contributes.commands.map(item => item.command)).toEqual(
      expect.arrayContaining([
        'actoviq.openSession',
        'actoviq.reviewDiff',
        'actoviq.applyDiff',
        'actoviq.restoreCheckpoint',
        'actoviq.setGoal',
      ]),
    );
  });
});
