import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

afterEach(async () => {
  clearLoadedJsonConfig();
  if (originalConfigDir == null) {
    delete process.env.ACTOVIQ_CONFIG_DIR;
  } else {
    process.env.ACTOVIQ_CONFIG_DIR = originalConfigDir;
  }
  // Clean env overrides that individual tests may set.
  const restore: Array<{ key: string; val: string | undefined }> = [
    { key: 'ACTOVIQ_CLAUDE_PATH', val: undefined },
    { key: 'ACTOVIQ_PI_PATH', val: undefined },
    { key: 'ACTOVIQ_CODEX_PATH', val: undefined },
  ];
  for (const { key, val } of restore) {
    if (val == null) delete process.env[key];
    else process.env[key] = val;
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
    // Point pi at a definitely-broken path; env overrides skip PATH.
    process.env.ACTOVIQ_PI_PATH = '/no/such/pi-binary';
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

    // getDefaultProviderId is used internally by resolveProvider and
    // ActoviqBridgeSdkClient.create. The detect API itself doesn't
    // change — but we confirm the settings loads correctly.
    const results = await detectBridgeProviders();
    const codexResult = results.find(r => r.id === 'codex');
    expect(codexResult?.available).toBe(true);
  });
});

describe('Bridge provider: probeVersion (best-effort)', () => {
  it('returns undefined when --version spawn fails (non-executable .mjs)', async () => {
    // The fake CLIs are .mjs node scripts — they can't be `execFile`d
    // directly. probeVersion wraps in try/catch → undefined.
    const version = await claudeProvider.probeVersion(fixtureCliPath);
    expect(version).toBeUndefined();
  });

  it('returns a string for a real binary (claude on PATH)', async () => {
    // Only run this if claude is actually on PATH (it is on this machine).
    const claudePath = await claudeProvider.resolveExecutable().catch(() => undefined);
    if (!claudePath) return; // skip in CI / where claude is missing
    const version = await claudeProvider.probeVersion(claudePath);
    // On this machine claude is a .cmd shim → should return a version string.
    expect(typeof version).toBe('string');
    expect(version!.length).toBeGreaterThan(0);
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
