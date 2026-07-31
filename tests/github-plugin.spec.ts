import { describe, expect, it, vi } from 'vitest';

import { createGitHubPlugin } from '../src/plugins/githubPlugin.js';

describe('GitHub plugin', () => {
  it('reuses the active gh login and reports the account without reading its token', async () => {
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === 'auth') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: 'octocat\n', stderr: '' };
    });
    const plugin = createGitHubPlugin({
      execFile,
      env: { PATH: '/fixture/bin' },
    });

    const status = await plugin.status();

    expect(status).toEqual({
      ok: true,
      state: 'authenticated',
      host: 'github.com',
      account: 'octocat',
      credentialSource: 'gh-cli',
      message: 'GitHub CLI is authenticated as octocat.',
    });
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'auth',
      'status',
      '--active',
      '--hostname',
      'github.com',
    ]);
    expect(execFile.mock.calls[1]?.[1]).toEqual([
      'api',
      'user',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '--jq',
      '.login',
    ]);
    const allArgs = execFile.mock.calls.flatMap((call) => call[1]);
    expect(allArgs).not.toContain('--show-token');
    expect(allArgs.join(' ')).not.toMatch(/\bauth token\b/);
  });

  it('injects an alternate token only into the child GH_TOKEN environment', async () => {
    const token = 'github_pat_super_secret';
    const execFile = vi.fn(async (_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(options.env.GH_TOKEN).toBe(token);
      expect(args.join(' ')).not.toContain(token);
      return args[0] === 'auth'
        ? { stdout: '', stderr: '' }
        : { stdout: 'alternate-user\n', stderr: '' };
    });
    const plugin = createGitHubPlugin({
      execFile,
      token,
      env: { PATH: '/fixture/bin' },
    });

    const status = await plugin.status();

    expect(status.credentialSource).toBe('alternate-token');
    expect(status.account).toBe('alternate-user');
    expect(JSON.stringify(status)).not.toContain(token);
    expect(plugin).not.toHaveProperty('token');
  });

  it('provides a read-only API action and parses JSON output', async () => {
    const execFile = vi.fn(async (
      _file: string,
      _args: string[],
      _options: { env: NodeJS.ProcessEnv },
    ) => ({
      stdout: '{"name":"hadamard","private":true}\n',
      stderr: '',
    }));
    const plugin = createGitHubPlugin({ execFile, env: {} });

    const result = await plugin.readApi('repos/acme/hadamard');

    expect(result).toEqual({ name: 'hadamard', private: true });
    expect(plugin.actions.readApi.isDestructive).toBe(false);
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'api',
      'repos/acme/hadamard',
      '--hostname',
      'github.com',
      '--method',
      'GET',
    ]);
  });

  it('marks all write API actions destructive and keeps field arguments structured', async () => {
    const execFile = vi.fn(async (
      _file: string,
      _args: string[],
      _options: { env: NodeJS.ProcessEnv },
    ) => ({ stdout: '{"id":42}\n', stderr: '' }));
    const plugin = createGitHubPlugin({ execFile, env: {} });

    const result = await plugin.actions.writeApi.execute({
      endpoint: 'repos/acme/hadamard/issues',
      method: 'POST',
      fields: {
        title: 'Fix plugin',
        draft: false,
      },
    });

    expect(result).toEqual({ id: 42 });
    expect(plugin.actions.writeApi.isDestructive).toBe(true);
    expect(plugin.actions.deleteApi.isDestructive).toBe(true);
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'api',
      'repos/acme/hadamard/issues',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '--field',
      'draft=false',
      '--raw-field',
      'title=Fix plugin',
    ]);
  });

  it('uses raw fields for query and body strings that begin with @', async () => {
    const execFile = vi.fn(async (
      _file: string,
      _args: string[],
      _options: { env: NodeJS.ProcessEnv },
    ) => ({ stdout: '{}\n', stderr: '' }));
    const plugin = createGitHubPlugin({ execFile, env: {} });

    await plugin.readApi('search/issues', {
      q: '@C:\\private\\query.txt',
    });
    await plugin.writeApi({
      endpoint: 'repos/acme/hadamard/issues',
      method: 'POST',
      fields: {
        body: '@C:\\private\\body.txt',
      },
    });

    expect(execFile.mock.calls[0]?.[1]).toEqual([
      'api',
      'search/issues',
      '--hostname',
      'github.com',
      '--method',
      'GET',
      '--raw-field',
      'q=@C:\\private\\query.txt',
    ]);
    expect(execFile.mock.calls[1]?.[1]).toEqual([
      'api',
      'repos/acme/hadamard/issues',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '--raw-field',
      'body=@C:\\private\\body.txt',
    ]);
  });

  it('rejects endpoints and field names that begin with a dash before invoking gh', async () => {
    const execFile = vi.fn(async (
      _file: string,
      _args: string[],
      _options: { env: NodeJS.ProcessEnv },
    ) => ({ stdout: '{}\n', stderr: '' }));
    const plugin = createGitHubPlugin({ execFile, env: {} });

    await expect(plugin.readApi('  --paginate  ')).rejects.toThrow(/endpoint/i);
    await expect(plugin.readApi('user', {
      '--paginate': 'true',
    })).rejects.toThrow(/field name/i);
    await expect(plugin.writeApi({
      endpoint: 'user',
      method: 'PATCH',
      fields: {
        '-F': '@payload.json',
      },
    })).rejects.toThrow(/field name/i);

    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a missing gh executable without leaking command output', async () => {
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('spawn gh ENOENT token=do-not-return'), { code: 'ENOENT' });
    });
    const plugin = createGitHubPlugin({ execFile, env: {} });

    const status = await plugin.status();

    expect(status).toEqual({
      ok: false,
      state: 'missing',
      host: 'github.com',
      credentialSource: 'gh-cli',
      message: 'GitHub CLI is not installed or is not available on PATH.',
    });
    expect(JSON.stringify(status)).not.toContain('do-not-return');
  });

  it('redacts an alternate token from invocation failures', async () => {
    const token = 'github_pat_do_not_leak';
    const execFile = vi.fn(async () => {
      throw new Error(`request failed with ${token}`);
    });
    const plugin = createGitHubPlugin({ execFile, token, env: {} });

    let failure: unknown;
    try {
      await plugin.readApi('user');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/GitHub CLI command failed/);
    expect((failure as Error).message).not.toContain(token);
  });
});
