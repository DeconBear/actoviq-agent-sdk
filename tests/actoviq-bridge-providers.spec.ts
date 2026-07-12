import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  loadJsonConfigFile,
  detectBridgeProviders,
} from '../src/index.js';
import { BRIDGE_PROVIDER_CREDENTIALS, claudeProvider, piProvider, codexProvider } from '../src/parity/bridgeProviders.js';

const tempDirs: string[] = [];
const fixtureCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-actoviq-runtime-cli.mjs');
const originalConfigDir = process.env.ACTOVIQ_CONFIG_DIR;
const providerPathEnvKeys = [
  'ACTOVIQ_CLAUDE_PATH',
  'ACTOVIQ_PI_PATH',
  'ACTOVIQ_CODEX_PATH',
  'ACTOVIQ_CODEWHALE_PATH',
  'ACTOVIQ_REASONIX_PATH',
  'ACTOVIQ_CRUSH_PATH',
] as const;
const originalProviderPaths = new Map(
  providerPathEnvKeys.map(key => [key, process.env[key]] as const),
);
const originalProbePidFile = process.env.ACTOVIQ_BRIDGE_PROBE_PID_FILE;

afterEach(async () => {
  clearLoadedJsonConfig();
  if (originalConfigDir == null) {
    delete process.env.ACTOVIQ_CONFIG_DIR;
  } else {
    process.env.ACTOVIQ_CONFIG_DIR = originalConfigDir;
  }
  for (const key of providerPathEnvKeys) {
    const original = originalProviderPaths.get(key);
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  }
  if (originalProbePidFile == null) delete process.env.ACTOVIQ_BRIDGE_PROBE_PID_FILE;
  else process.env.ACTOVIQ_BRIDGE_PROBE_PID_FILE = originalProbePidFile;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function maskProviderExecutablesAsMissing(): void {
  for (const key of providerPathEnvKeys) {
    process.env[key] = path.join(os.tmpdir(), 'actoviq-definitely-missing-provider');
  }
}

async function createHangingVersionExecutable(): Promise<{
  executablePath: string;
  pidFile: string;
}> {
  const tempDir = await createTempDir('bridge-prov-hanging-');
  const pidFile = path.join(tempDir, 'pids.txt');
  const scriptPath = path.join(tempDir, 'hang-version.mjs');
  const script = [
    `import { appendFileSync } from 'node:fs';`,
    `appendFileSync(process.env.ACTOVIQ_BRIDGE_PROBE_PID_FILE, String(process.pid) + '\\n');`,
    `setInterval(() => {}, 1_000);`,
    '',
  ].join('\n');

  if (process.platform !== 'win32') {
    await writeFile(scriptPath, `#!/usr/bin/env node\n${script}`, 'utf8');
    await chmod(scriptPath, 0o755);
    return { executablePath: scriptPath, pidFile };
  }

  await writeFile(scriptPath, script, 'utf8');
  const wrapperPath = path.join(tempDir, 'hang-version.cmd');
  await writeFile(
    wrapperPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    'utf8',
  );
  return { executablePath: wrapperPath, pidFile };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Bridge provider: resolveExecutable precedence', () => {
  it('returns explicitPath when provided, skipping env + settings', async () => {
    const explicit = path.resolve(fixtureCliPath);
    const result = await claudeProvider.resolveExecutable(explicit);
    expect(result).toBe(explicit);
  });

  it('reads ACTOVIQ_<ID>_PATH from the loaded settings env block', async () => {
    const tempDir = await createTempDir('bridge-prov-resolve-env-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ env: { ACTOVIQ_CLAUDE_PATH: fixtureCliPath } }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);

    const result = await claudeProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('reads ACTOVIQ_<ID>_PATH from process.env as fallback after settings env', async () => {
    process.env.ACTOVIQ_CODEX_PATH = fixtureCliPath;
    const result = await codexProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('reads bridge.providers[id].path from the settings block', async () => {
    const tempDir = await createTempDir('bridge-prov-resolve-block-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        bridge: {
          defaultProvider: 'pi',
          providers: { pi: { path: fixtureCliPath } },
        },
      }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);

    const result = await piProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('rejects an explicitPath that is not executable / does not exist', async () => {
    await expect(claudeProvider.resolveExecutable('/no/such/claude-binary')).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects an ACTOVIQ_<ID>_PATH that points at a missing file', async () => {
    process.env.ACTOVIQ_PI_PATH = '/no/such/pi-binary';
    await expect(piProvider.resolveExecutable()).rejects.toThrow(
      /ACTOVIQ_PI_PATH.*not found/,
    );
  });
});

describe('detectBridgeProviders', () => {
  it('returns entries for all six registered providers', async () => {
    maskProviderExecutablesAsMissing();
    const results = await detectBridgeProviders();
    expect(results).toHaveLength(6);

    for (const entry of results) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('displayName');
      expect(entry).toHaveProperty('available');
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('version');
      if (entry.available) {
        expect(typeof entry.path).toBe('string');
      }
    }
  });

  it('reports unavailable when a provider is unresolvable', async () => {
    // Broken env overrides skip PATH and keep this test independent from
    // whatever provider CLIs happen to be installed on the host.
    maskProviderExecutablesAsMissing();
    const results = await detectBridgeProviders();
    const piResult = results.find(r => r.id === 'pi');
    expect(piResult?.available).toBe(false);
    expect(piResult?.path).toBeUndefined();
    expect(piResult?.version).toBeUndefined();
  });

  it('honours the defaultProvider from bridge settings', async () => {
    const tempDir = await createTempDir('bridge-prov-detect-default-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ bridge: { defaultProvider: 'codex' } }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);
    maskProviderExecutablesAsMissing();

    // getDefaultProviderId is used internally by resolveProvider and
    // ActoviqBridgeSdkClient.create. The detect API itself doesn't
    // change — but we confirm settings load correctly (all six entries
    // present, regardless of what's on PATH).
    const results = await detectBridgeProviders();
    expect(results.find(r => r.id === 'codex')).toBeDefined();
    expect(results).toHaveLength(6);
  });

  it('bounds direct probes and avoids unkillable Windows batch-shim trees', async () => {
    const { executablePath, pidFile } = await createHangingVersionExecutable();
    process.env.ACTOVIQ_BRIDGE_PROBE_PID_FILE = pidFile;
    for (const key of providerPathEnvKeys) process.env[key] = executablePath;

    const startedAt = Date.now();
    const results = await detectBridgeProviders({ probeTimeoutMs: 750 });
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(6);
    expect(results.every(result => result.available && result.version === undefined)).toBe(true);
    // Windows batch shims are deliberately not executed because restricted
    // hosts may deny taskkill /T; direct probes on other platforms time out.
    expect(elapsedMs).toBeLessThan(process.platform === 'win32' ? 5_000 : 4_000);

    const pidText = await readFile(pidFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const pids = pidText
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    if (process.platform === 'win32') {
      expect(pids).toEqual([]);
      return;
    }
    expect(pids.length).toBeGreaterThan(0);
    const alivePids = pids.filter(isProcessAlive);
    expect(alivePids, `Timed-out provider probes still alive: ${alivePids.join(', ')}`).toEqual([]);
  }, 10_000);
});

describe('Bridge provider: probeVersion (best-effort)', () => {
  it('returns undefined when --version spawn fails (non-executable .mjs)', async () => {
    // The fake CLIs are .mjs node scripts — they can't be spawned
    // directly. probeVersion wraps in try/catch → undefined.
    const version = await claudeProvider.probeVersion(fixtureCliPath);
    expect(version).toBeUndefined();
  });

  it('returns a version for a real binary without consulting a shell profile', async () => {
    const version = await claudeProvider.probeVersion(process.execPath);
    expect(version).toBe(process.version);
  });
});

describe('BRIDGE_PROVIDER_CREDENTIALS', () => {
  // Advisory display data only — surfaces which env var each provider's CLI
  // reads so the TUI /bridge board can show credential readiness.
  it('covers all six providers', () => {
    expect(Object.keys(BRIDGE_PROVIDER_CREDENTIALS).sort()).toEqual([
      'claude',
      'codewhale',
      'codex',
      'crush',
      'pi',
      'reasonix',
    ]);
  });

  it('lists the credential vars each known provider reads', () => {
    expect(BRIDGE_PROVIDER_CREDENTIALS.claude).toContain('ANTHROPIC_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.claude).toContain('ACTOVIQ_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.pi).toContain('OPENAI_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.codex).toContain('OPENAI_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.reasonix).toContain('DEEPSEEK_API_KEY');
  });

  it('uses an empty list (honest "unknown") for multi-backend providers', () => {
    expect(BRIDGE_PROVIDER_CREDENTIALS.codewhale).toEqual([]);
    expect(BRIDGE_PROVIDER_CREDENTIALS.crush).toEqual([]);
  });
});
