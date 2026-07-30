import type { FileChangeRecord, FileCheckpoint, FileCheckpointStatus } from './types.js';
import { FileCheckpointService } from './fileCheckpointService.js';

export class FileChangeJournal {
  constructor(private readonly service: FileCheckpointService) {}

  beginTurn(input: {
    sessionId: string;
    turnId: string;
    label?: string;
    conversationCheckpointId?: string;
  }): Promise<FileCheckpoint> {
    return this.service.beginTurn(input);
  }

  record(change: FileChangeRecord): Promise<FileCheckpoint> {
    return this.service.recordChange(change);
  }

  sealTurn(
    sessionId: string,
    turnId: string,
    status: FileCheckpointStatus,
  ): Promise<FileCheckpoint | null> {
    return this.service.sealTurn(sessionId, turnId, status);
  }
}
