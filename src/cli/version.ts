import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function hasVersionFlag(argv: readonly string[]): boolean {
  return argv.includes('--version') || argv.includes('-v');
}

export function readPackageVersion(startUrl: string): string {
  let dir = path.dirname(fileURLToPath(startUrl));
  const root = path.parse(dir).root;

  while (true) {
    const packagePath = path.join(dir, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (packageJson.name === 'actoviq-agent-sdk' && typeof packageJson.version === 'string') {
          return packageJson.version;
        }
      } catch {
        // Keep walking; a parent package.json may be the package root.
      }
    }

    if (dir === root) return 'unknown';
    dir = path.dirname(dir);
  }
}
