export const FILE_CHECKPOINT_SCHEMA_VERSION = 1;

export type CheckpointRestoreMode = 'files' | 'conversation' | 'both';
export type FileCheckpointStatus = 'open' | 'completed' | 'failed' | 'aborted';

export interface FileCheckpointEntry {
  path: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeHash?: string;
  afterHash?: string;
  beforeBlob?: string;
  afterBlob?: string;
  binary: boolean;
  sizeBefore: number;
  sizeAfter: number;
  recoverable: boolean;
  omittedReason?: string;
}

export interface FileCheckpoint {
  version: typeof FILE_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  id: string;
  sessionId: string;
  turnId: string;
  label: string;
  workspaceRoot: string;
  conversationCheckpointId?: string;
  status: FileCheckpointStatus;
  entries: FileCheckpointEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRestoreConflict {
  path: string;
  expectedHash?: string;
  actualHash?: string;
  reason: 'modified-after-checkpoint' | 'unrecoverable-entry' | 'path-escape';
  message: string;
}

export interface CheckpointPreview {
  checkpoint: FileCheckpoint;
  conflicts: CheckpointRestoreConflict[];
  files: Array<{
    path: string;
    action: 'restore' | 'delete' | 'unchanged' | 'unrecoverable';
    binary: boolean;
    sizeBefore: number;
    sizeAfter: number;
  }>;
}

export interface CheckpointRestoreResult {
  checkpointId: string;
  mode: CheckpointRestoreMode;
  restoredFiles: string[];
  conversationRestored: boolean;
  conflicts: CheckpointRestoreConflict[];
}

export interface FileChangeRecord {
  sessionId: string;
  turnId: string;
  filePath: string;
  before: Buffer | null;
  after: Buffer | null;
}
