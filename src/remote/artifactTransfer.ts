import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertSafeStorageSegment } from '../storage/pathSafety.js';
import { createId } from '../runtime/helpers.js';

export interface RemoteArtifact {
  name: string;
  size: number;
  sha256: string;
  path: string;
}

export class ArtifactTransfer {
  constructor(
    private readonly rootDirectory: string,
    private readonly maxBytes = 25 * 1024 * 1024,
  ) {}

  async receive(name: string, content: Uint8Array, expectedSha256: string): Promise<RemoteArtifact> {
    assertSafeStorageSegment('artifactName', name);
    if (content.byteLength > this.maxBytes) {
      throw new Error(`Artifact exceeds ${this.maxBytes} byte limit.`);
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (sha256 !== expectedSha256.toLowerCase()) {
      throw new Error(`Artifact SHA-256 mismatch for "${name}".`);
    }
    await mkdir(this.rootDirectory, { recursive: true });
    const filePath = path.join(this.rootDirectory, name);
    const tempPath = `${filePath}.${createId()}.tmp`;
    try {
      await writeFile(tempPath, content);
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { name, size: content.byteLength, sha256, path: filePath };
  }

  async read(name: string): Promise<{ artifact: RemoteArtifact; content: Buffer }> {
    assertSafeStorageSegment('artifactName', name);
    const filePath = path.join(this.rootDirectory, name);
    const content = await readFile(filePath);
    if (content.byteLength > this.maxBytes) throw new Error('Stored artifact exceeds size limit.');
    return {
      artifact: {
        name,
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        path: filePath,
      },
      content,
    };
  }
}
