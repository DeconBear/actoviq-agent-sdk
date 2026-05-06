import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { MessageParam } from '../provider/types.js';

export interface TranscriptEntry {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd: string;
  message: { role: string; content: unknown };
}

export async function appendMessagesToTranscript(
  transcriptDir: string,
  sessionId: string,
  cwd: string,
  messages: MessageParam[],
  parentUuid: string | null = null,
): Promise<void> {
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

  const lines: string[] = [];
  let lastUuid = parentUuid;

  for (const message of messages) {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const uuid = randomUUID();
    lines.push(
      JSON.stringify({
        type: role,
        uuid,
        parentUuid: lastUuid,
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        message: { role, content: message.content },
      }) + '\n',
    );
    lastUuid = uuid;
  }

  if (lines.length > 0) {
    await appendFile(transcriptPath, lines.join(''));
  }
}
