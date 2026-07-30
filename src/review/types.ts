export interface ThreadDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  additions: number;
  deletions: number;
  patch: string;
}

export interface ThreadDiff {
  sessionId: string;
  repoRoot: string;
  worktreePath: string;
  baseCommit: string;
  headCommit: string;
  files: ThreadDiffFile[];
  patch: string;
  generatedAt: string;
}

export interface ReviewComment {
  id: string;
  filePath: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadReview {
  version: 1;
  revision: number;
  sessionId: string;
  comments: ReviewComment[];
  createdAt: string;
  updatedAt: string;
}

export interface DiffApplyResult {
  applied: boolean;
  conflict: boolean;
  message: string;
}
