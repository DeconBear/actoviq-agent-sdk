import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveActoviqHome } from './actoviqHome.js';

const MAX_PROJECT_KEY_LENGTH = 200;

export function encodeActoviqProjectPath(workDir: string): string {
  const resolved = path.resolve(workDir).normalize('NFC');
  const sanitized = resolved.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_PROJECT_KEY_LENGTH) {
    return sanitized;
  }
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return `${sanitized.slice(0, MAX_PROJECT_KEY_LENGTH)}-${hash}`;
}

export function getActoviqProjectSessionDirectory(
  workDir: string,
  homeDir: string,
): string {
  return path.join(resolveActoviqHome(homeDir), 'projects', encodeActoviqProjectPath(workDir));
}

export async function migrateLegacyActoviqProjectSessions(options: {
  homeDir: string;
  workDir: string;
  targetDirectory: string;
}): Promise<number> {
  const legacySessions = path.join(
    resolveActoviqHome(options.homeDir),
    'actoviq-agent-sdk',
    'sessions',
  );
  let files: string[];
  try {
    files = await readdir(legacySessions);
  } catch {
    return 0;
  }

  const targetSessions = path.join(options.targetDirectory, 'sessions');
  await mkdir(targetSessions, { recursive: true });
  let migrated = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const source = path.join(legacySessions, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(source, 'utf8'));
    } catch {
      continue;
    }
    const storedWorkDir =
      typeof parsed === 'object' &&
      parsed !== null &&
      'metadata' in parsed &&
      typeof parsed.metadata === 'object' &&
      parsed.metadata !== null &&
      '__actoviqWorkDir' in parsed.metadata &&
      typeof parsed.metadata.__actoviqWorkDir === 'string'
        ? parsed.metadata.__actoviqWorkDir
        : undefined;
    if (!storedWorkDir || !samePath(storedWorkDir, options.workDir)) continue;

    const target = path.join(targetSessions, file);
    try {
      await access(target);
      continue;
    } catch {
      await copyFile(source, target);
      migrated += 1;
    }

    const sessionId = file.slice(0, -'.json'.length);
    const legacyCheckpoints = path.join(legacySessions, '.checkpoints', sessionId);
    const targetCheckpoints = path.join(targetSessions, '.checkpoints', sessionId);
    try {
      await cp(legacyCheckpoints, targetCheckpoints, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
    } catch {
      // Checkpoints are optional.
    }
  }
  return migrated;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).normalize('NFC');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
