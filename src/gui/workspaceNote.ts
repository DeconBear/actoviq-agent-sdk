import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getActoviqProjectSessionDirectory } from '../config/projectSessionDirectory.js';

export function workspaceNotePath(workDir: string, homeDir: string): string {
  return path.join(getActoviqProjectSessionDirectory(workDir, homeDir), 'workspace-note.txt');
}

export async function readWorkspaceNote(workDir: string, homeDir: string): Promise<string> {
  try {
    return await readFile(workspaceNotePath(workDir, homeDir), 'utf8');
  } catch {
    return '';
  }
}

export async function writeWorkspaceNote(workDir: string, homeDir: string, content: string): Promise<string> {
  const filePath = workspaceNotePath(workDir, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}
