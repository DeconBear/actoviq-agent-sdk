import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { hasVersionFlag, readPackageVersion } from '../src/cli/version.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('CLI version helpers', () => {
  it('detects short and long version flags', () => {
    expect(hasVersionFlag(['--version'])).toBe(true);
    expect(hasVersionFlag(['-v'])).toBe(true);
    expect(hasVersionFlag(['--model', 'deepseek-v4-pro'])).toBe(false);
  });

  it('reads the project package version from the current source tree', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };

    expect(readPackageVersion(import.meta.url)).toBe(packageJson.version);
  });

  it('walks upward from a compiled nested CLI path', async () => {
    const tempDir = await createTempDir('actoviq-cli-version-');
    const nestedDir = path.join(tempDir, 'dist', 'src', 'cli');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'actoviq-agent-sdk', version: '9.8.7' }),
      'utf8',
    );

    const nestedUrl = pathToFileURL(path.join(nestedDir, 'version.js')).href;

    expect(readPackageVersion(nestedUrl)).toBe('9.8.7');
  });
});
