import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createManagedPluginRuntime,
  prepareKimiCommandArgs,
} from '../src/plugins/managedPluginRuntime.js';
import { patchManagedPluginSettings } from '../src/plugins/managedPluginCatalog.js';
import { decideActoviqToolPermission } from '../src/runtime/actoviqPermissions.js';

describe('managed plugin runtime', () => {
  it('mounts only enabled and configured managed plugin tools', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', {
      enabled: true,
      apiKey: 'qwen-secret',
      provider: 'qwen',
      api: 'responses',
    });
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'local',
    });
    patchManagedPluginSettings(raw, 'github', {
      enabled: true,
      hostname: 'github.com',
    });
    patchManagedPluginSettings(raw, 'kimi-webbridge', {
      enabled: true,
      daemonUrl: 'http://127.0.0.1:10086',
    });
    patchManagedPluginSettings(raw, 'playwright', {
      enabled: true,
      headless: true,
      channel: 'chromium',
    });
    patchManagedPluginSettings(raw, 'tavily', {
      enabled: true,
      apiKey: 'tvly-secret',
    });
    patchManagedPluginSettings(raw, 'exa', {
      enabled: true,
      apiKey: 'exa-secret',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    const names = runtime.tools.map(item => item.name);

    expect(names).toEqual(expect.arrayContaining([
      'ocr_extract',
      'computer_open_url',
      'github_status',
      'github_read_api',
      'github_write_api',
      'kimi_webbridge',
      'browser_navigate',
      'browser_snapshot',
      'TavilySearch',
      'ExaSearch',
    ]));
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('qwen-secret');
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('tvly-secret');
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('exa-secret');
    await runtime.close();
  });

  it('does not mount tools that still need a credential', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', { enabled: true });
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'e2b',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    expect(runtime.tools).toEqual([]);
    await runtime.close();
  });

  it('mounts the E2B driver lazily when configured', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'e2b',
      e2bApiKey: 'e2b-secret',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    expect(runtime.tools.map(item => item.name)).toContain('computer_start');
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('e2b-secret');
    await runtime.close();
  });

  it('requires interaction for remote GitHub writes and signed-in Kimi browser access', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'github', { enabled: true });
    patchManagedPluginSettings(raw, 'kimi-webbridge', { enabled: true });
    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });

    try {
      const githubWrite = runtime.tools.find(item => item.name === 'github_write_api')!;
      const kimi = runtime.tools.find(item => item.name === 'kimi_webbridge')!;
      expect(githubWrite.isDestructive?.({})).toBe(true);
      expect(githubWrite.requiresUserInteraction?.()).toBe(true);
      expect(kimi.requiresUserInteraction?.()).toBe(true);
      expect(kimi.isReadOnly?.({ action: 'screenshot', args: {} })).toBe(true);
      expect(kimi.isDestructive?.({
        action: 'screenshot',
        args: { path: 'screen.png' },
      })).toBe(true);
      for (const [definition, toolInput] of [
        [githubWrite, {
          endpoint: 'repos/example/project/issues',
          method: 'POST',
          fields: { title: 'test' },
        }],
        [kimi, { action: 'click', args: { ref: 1 } }],
      ] as const) {
        const approver = vi.fn(async () => ({
          behavior: 'allow' as const,
          reason: 'approved',
        }));
        const decision = await decideActoviqToolPermission({
          mode: 'bypassPermissions',
          rules: [],
          approver,
          adapter: definition,
          runId: 'run-managed-plugin',
          workDir: process.cwd(),
          toolName: definition.name,
          publicName: definition.name,
          prompt: 'managed plugin security test',
          toolInput,
          iteration: 1,
        });
        expect(approver, definition.name).toHaveBeenCalledOnce();
        expect(decision.behavior, definition.name).toBe('allow');
      }
    } finally {
      await runtime.close();
    }
  });

  it('constrains Kimi output and upload paths to the workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'actoviq-kimi-policy-'));
    const canonicalWorkspace = realpathSync.native(workspace);
    const source = path.join(workspace, 'upload.txt');
    await writeFile(source, 'safe', 'utf8');

    try {
      expect(prepareKimiCommandArgs('screenshot', { path: 'screen.png' }, workspace))
        .toEqual({ path: path.join(canonicalWorkspace, 'screen.png') });
      expect(prepareKimiCommandArgs('upload', { files: ['upload.txt'] }, workspace))
        .toEqual({ files: [realpathSync.native(source)] });
      expect(() =>
        prepareKimiCommandArgs('screenshot', { path: '../outside.png' }, workspace),
      ).toThrow(/inside the workspace/i);
      expect(() =>
        prepareKimiCommandArgs('upload', { files: ['../outside.txt'] }, workspace),
      ).toThrow(/inside the workspace/i);
      expect(() =>
        prepareKimiCommandArgs('save_as_pdf', {}, workspace),
      ).toThrow(/requires a workspace output path/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
