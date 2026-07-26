import { describe, expect, it } from 'vitest';

import { probeExternalCliAuth } from '../src/parity/externalCliAuth.js';

describe('external CLI authentication probe', () => {
  it('reports Claude native OAuth without exposing credential data', async () => {
    const status = await probeExternalCliAuth('claude', {
      executable: '/fixture/claude',
      runCommand: async () => ({
        exitCode: 0,
        stdout: '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty","token":"secret"}\n',
        stderr: '',
      }),
    });

    expect(status).toEqual({
      runtime: 'claude',
      state: 'authenticated',
      source: 'native-cli',
      method: 'oauth_token',
      provider: 'firstParty',
      message: 'Claude Code reports an active native login.',
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(status).not.toHaveProperty('token');
  });

  it('parses pretty-printed Claude status after a CLI warning', async () => {
    const status = await probeExternalCliAuth('claude', {
      executable: '/fixture/claude',
      runCommand: async () => ({
        exitCode: 0,
        stdout: 'Update available\n{\n  "loggedIn": true,\n  "authMethod": "oauth_token",\n  "apiProvider": "firstParty"\n}\n',
        stderr: '',
      }),
    });

    expect(status).toMatchObject({
      runtime: 'claude',
      state: 'authenticated',
      method: 'oauth_token',
      provider: 'firstParty',
    });
  });

  it('reports Codex not logged in from its non-zero status command', async () => {
    const status = await probeExternalCliAuth('codex', {
      executable: '/fixture/codex',
      runCommand: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Not logged in',
      }),
    });

    expect(status).toMatchObject({
      runtime: 'codex',
      state: 'not_authenticated',
    });
  });

  it('distinguishes a missing runtime from an unrecognized status', async () => {
    const missing = await probeExternalCliAuth('claude', {
      resolveExecutable: async () => {
        throw new Error('missing');
      },
    });
    expect(missing.state).toBe('missing');

    const unknown = await probeExternalCliAuth('codex', {
      executable: '/fixture/codex',
      runCommand: async () => ({ exitCode: null, stdout: '', stderr: 'failed' }),
    });
    expect(unknown.state).toBe('unknown');
  });

  it('detects CodeWhale native provider status without returning key suffixes', async () => {
    const status = await probeExternalCliAuth('codewhale', {
      executable: '/fixture/codewhale',
      runCommand: async (_executable, args) => {
        expect(args).toEqual(['auth', 'status']);
        return {
          exitCode: 0,
          stdout: 'active provider: openai-codex\n* openai-codex | oauth file | ****1234\n',
          stderr: '',
        };
      },
    });
    expect(status).toMatchObject({
      runtime: 'codewhale',
      state: 'authenticated',
      provider: 'openai-codex',
    });
    expect(JSON.stringify(status)).not.toContain('1234');
  });

  it('reports the Pi offline model catalog as a capability, not verified authentication', async () => {
    const status = await probeExternalCliAuth('pi', {
      executable: '/fixture/pi',
      runCommand: async (_executable, args) => {
        expect(args).toEqual(['--offline', '--list-models']);
        return { exitCode: 0, stdout: 'configured-model\n', stderr: '' };
      },
    });

    expect(status).toEqual({
      runtime: 'pi',
      state: 'unknown',
      source: 'native-cli',
      method: 'model-catalog',
      message: 'Pi CLI model catalog is available, but this offline probe cannot verify a provider login or API key.',
    });
  });

  it('reports Crush native configuration through its non-secret model probe', async () => {
    const status = await probeExternalCliAuth('crush', {
      executable: '/fixture/crush',
      runCommand: async (_executable, args) => {
        expect(args).toEqual(['models']);
        return { exitCode: 0, stdout: 'configured-model\n', stderr: '' };
      },
    });
    expect(status).toMatchObject({ runtime: 'crush', state: 'configured' });
  });

  it('does not invoke interactive Reasonix setup while probing native auth', async () => {
    let invoked = false;
    const status = await probeExternalCliAuth('reasonix', {
      executable: '/fixture/reasonix',
      runCommand: async () => {
        invoked = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(invoked).toBe(false);
    expect(status).toMatchObject({
      runtime: 'reasonix',
      state: 'unknown',
      method: 'reasonix-setup',
    });
  });
});
