import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const historyGate = vi.hoisted(() => ({
  enabled: false,
  calls: [] as Array<{ runtimes?: string[] }>,
}));

vi.mock('../src/parity/externalCliSessions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/parity/externalCliSessions.js')>();
  const crushSessions = () => {
    const runtime = 'crush' as const;
    const nativeSessionId = '33333333-3333-4333-8333-333333333333';
    const managedProfileId = actual.namedExternalCliManagedProfileId(runtime, 'crush-managed');
    const summary = {
      runtime,
      nativeSessionId,
      title: 'same Crush history',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:01:00.000Z',
      messageCount: 1,
    };
    return [
      {
        ...summary,
        path: 'hadamard-crush-session:v1:'
          + Buffer.from(nativeSessionId).toString('base64url'),
      },
      {
        ...summary,
        path: 'hadamard-crush-session:v2:'
          + Buffer.from(`${managedProfileId}:${nativeSessionId}`).toString('base64url'),
      },
    ];
  };
  return {
    ...actual,
    listExternalCliSessions: async (
      options: Parameters<typeof actual.listExternalCliSessions>[0] = {},
    ) => {
      if (!historyGate.enabled) return actual.listExternalCliSessions(options);
      historyGate.calls.push({
        ...(options.runtimes ? { runtimes: [...options.runtimes] } : {}),
      });
      const runtime = options.runtimes?.[0] ?? 'claude';
      if (runtime === 'crush') return crushSessions();
      return [{
        runtime,
        nativeSessionId: `${runtime}-session`,
        title: `${runtime} history`,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:01:00.000Z',
        messageCount: 1,
        path: `/virtual/${runtime}-session.jsonl`,
      }];
    },
    readExternalCliSession: async (
      sessionPath: string,
      options: Parameters<typeof actual.readExternalCliSession>[1] = {},
    ) => {
      if (!historyGate.enabled || !sessionPath.startsWith('hadamard-crush-session:')) {
        return actual.readExternalCliSession(sessionPath, options);
      }
      const found = crushSessions().find(session => session.path === sessionPath);
      return found
        ? {
            summary: found,
            messages: [{ role: 'assistant' as const, text: 'crush history detail' }],
          }
        : undefined;
    },
  };
});

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { writeBridgeConfigs } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  historyGate.enabled = false;
  historyGate.calls.length = 0;
  await Promise.all(tempDirs.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

describe('GUI external CLI history API', () => {
  it('passes all six managed runtime filters through the history gate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-history-gates-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    await mkdir(path.join(homeDir, '.hadamard'), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(homeDir, '.hadamard', 'settings.json'), JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_MODEL: 'test-model',
      },
    }), 'utf8');
    historyGate.enabled = true;
    const server = await startHadamardGuiServer({
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    const request = async (runtime: string) => {
      const response = await fetch(new URL(
        '/api/external-cli/sessions?runtime=' + encodeURIComponent(runtime),
        server.url,
      ), {
        headers: { 'x-hadamard-token': server.token },
      });
      return {
        status: response.status,
        body: await response.json() as {
          sessions: Array<{
            runtime: string;
            nativeSessionId: string;
            sourceLabel?: string;
          }>;
        },
      };
    };

    try {
      for (const runtime of [
        'claude',
        'codex',
        'pi',
        'codewhale',
        'reasonix',
        'crush',
      ]) {
        const response = await request(runtime);
        expect(response.status, runtime).toBe(200);
        if (runtime === 'crush') {
          expect(response.body.sessions).toEqual([
            expect.objectContaining({
              runtime,
              nativeSessionId: '33333333-3333-4333-8333-333333333333',
              sourceLabel: 'Native login',
            }),
            expect.objectContaining({
              runtime,
              nativeSessionId: '33333333-3333-4333-8333-333333333333',
              sourceLabel: expect.stringMatching(/^Managed profile · [0-9a-f]{8}$/u),
            }),
          ]);
        } else {
          expect(response.body.sessions).toEqual([
            expect.objectContaining({
              runtime,
              nativeSessionId: `${runtime}-session`,
            }),
          ]);
          expect(response.body.sessions[0]).not.toHaveProperty('sourceLabel');
        }
      }
      expect(historyGate.calls.map(call => call.runtimes)).toEqual([
        ['claude'],
        ['codex'],
        ['pi'],
        ['codewhale'],
        ['reasonix'],
        ['crush'],
      ]);

      const unmanaged = await request('hadamard');
      expect(unmanaged.status).toBe(200);
      expect(historyGate.calls.at(-1)?.runtimes).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('binds same-id Crush history detail and resume to the exact auth profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-crush-binding-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    await mkdir(path.join(homeDir, '.hadamard'), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(homeDir, '.hadamard', 'settings.json'), JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_MODEL: 'test-model',
      },
    }), 'utf8');
    writeBridgeConfigs({
      configs: [
        {
          name: 'crush-native',
          runtime: 'crush',
          execution: 'cli',
          authSource: 'native',
          provider: 'openai',
        },
        {
          name: 'crush-managed',
          runtime: 'crush',
          execution: 'cli',
          authSource: 'apiKey',
          provider: 'openai',
          apiKey: 'managed-key',
        },
        {
          name: 'crush-other-profile',
          runtime: 'crush',
          execution: 'cli',
          authSource: 'apiKey',
          provider: 'openai',
          apiKey: 'other-key',
        },
      ],
    }, homeDir);
    historyGate.enabled = true;
    const server = await startHadamardGuiServer({
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    const request = async (
      requestPath: string,
      init: RequestInit = {},
    ): Promise<{ status: number; body: Record<string, any> }> => {
      const response = await fetch(new URL(requestPath, server.url), {
        ...init,
        headers: {
          'x-hadamard-token': server.token,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      const listed = await request('/api/external-cli/sessions?runtime=crush');
      const native = listed.body.sessions.find((session: Record<string, unknown>) =>
        session.sourceLabel === 'Native login');
      const managed = listed.body.sessions.find((session: Record<string, unknown>) =>
        String(session.sourceLabel).startsWith('Managed profile'));
      expect(native?.id).toEqual(expect.any(String));
      expect(managed?.id).toEqual(expect.any(String));

      const nativeDetail = await request(
        '/api/external-cli/session?id=' + encodeURIComponent(native.id),
      );
      const managedDetail = await request(
        '/api/external-cli/session?id=' + encodeURIComponent(managed.id),
      );
      expect(nativeDetail.body.compatibleConfigNames).toEqual(['crush-native']);
      expect(managedDetail.body.compatibleConfigNames).toEqual(['crush-managed']);

      const resume = (id: string, configName: string) => request(
        '/api/external-cli/session/resume',
        { method: 'POST', body: JSON.stringify({ id, configName }) },
      );
      expect((await resume(native.id, 'crush-managed')).status).toBe(400);
      expect((await resume(managed.id, 'crush-native')).status).toBe(400);
      expect((await resume(managed.id, 'crush-other-profile')).status).toBe(400);
      expect((await resume(managed.id, 'crush-managed')).status).toBe(200);
      expect((await resume(native.id, 'crush-native')).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('lists and reads native sessions without exposing filesystem paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-external-history-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    const nativeSessionId = '11111111-2222-3333-4444-555555555555';
    const configuredApiKey = 'configured-history-api-key';
    const sessionPath = path.join(
      homeDir,
      '.claude',
      'projects',
      'workspace',
      nativeSessionId + '.jsonl',
    );
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(path.join(homeDir, '.hadamard'), { recursive: true });
    await writeFile(path.join(homeDir, '.hadamard', 'settings.json'), JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-key',
        HADAMARD_MODEL: 'test-model',
      },
    }), 'utf8');
    writeBridgeConfigs({
      configs: [{
        name: 'history-claude',
        runtime: 'claude',
        execution: 'cli',
        authSource: 'apiKey',
        provider: 'anthropic',
        apiKey: configuredApiKey,
      }],
    }, homeDir);
    await writeFile(sessionPath, [
      JSON.stringify({
        type: 'summary',
        sessionId: nativeSessionId,
        summary: 'token=history-title-secret',
      }),
      JSON.stringify({
        type: 'user',
        sessionId: nativeSessionId,
        cwd: workDir,
        timestamp: '2026-07-13T08:00:00.000Z',
        message: { role: 'user', content: 'Inspect native history' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: nativeSessionId,
        cwd: workDir,
        timestamp: '2026-07-13T08:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `History is available. ${configuredApiKey} Bearer bearer-history-secret password=hunter2`,
            },
            {
              type: 'tool_use',
              id: 'tool-secret',
              name: 'inspect_config',
              input: {
                apiKey: configuredApiKey,
                nested: { password: 'tool-password-secret', safe: 'visible-value' },
              },
            },
          ],
        },
      }),
    ].join('\n'), 'utf8');

    const server = await startHadamardGuiServer({
      homeDir,
      workDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });
    const request = async (requestPath: string) => {
      const response = await fetch(new URL(requestPath, server.url), {
        headers: { 'x-hadamard-token': server.token },
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    try {
      const listed = await request('/api/external-cli/sessions?runtime=claude');
      expect(listed.status).toBe(200);
      expect(listed.body.sessions).toEqual([
        expect.objectContaining({
          runtime: 'claude',
          nativeSessionId,
          title: 'token=[REDACTED]',
          id: expect.any(String),
        }),
      ]);
      expect(listed.body.sessions[0]).not.toHaveProperty('path');
      expect(JSON.stringify(listed.body)).not.toContain(sessionPath);
      expect(Buffer.from(listed.body.sessions[0].id, 'base64url').toString('utf8'))
        .not.toBe(sessionPath);

      const detail = await request(
        '/api/external-cli/session?id=' + encodeURIComponent(listed.body.sessions[0].id),
      );
      expect(detail.status).toBe(200);
      expect(detail.body.session.summary).not.toHaveProperty('path');
      const serializedDetail = JSON.stringify(detail.body);
      expect(serializedDetail).not.toContain(configuredApiKey);
      expect(serializedDetail).not.toContain('bearer-history-secret');
      expect(serializedDetail).not.toContain('hunter2');
      expect(serializedDetail).not.toContain('tool-password-secret');
      expect(serializedDetail).toContain('[REDACTED]');
      expect(detail.body.session.messages[1].tools[0].input).toEqual({
        apiKey: '[REDACTED]',
        nested: { password: '[REDACTED]', safe: 'visible-value' },
      });

      const outsideId = Buffer.from(path.join(root, 'outside.jsonl'), 'utf8').toString('base64url');
      const unsafe = await request('/api/external-cli/session?id=' + encodeURIComponent(outsideId));
      expect(unsafe.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
