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

// --- Progressive Review Summary types ---

export type ReviewChangeImpact = 'added' | 'modified' | 'removed' | 'refactored';

export interface ReviewFileChange {
  path: string;
  impact: ReviewChangeImpact;
  /** One sentence describing what changed in this file. */
  summary: string;
}

export interface ReviewSemanticGroup {
  /** User-perceivable behaviour change title. */
  title: string;
  impact: ReviewChangeImpact;
  /** 2-3 sentence natural language explanation. */
  description: string;
  files: ReviewFileChange[];
}

export interface ReviewSummary {
  /** One-line overall summary. */
  headline: string;
  groups: ReviewSemanticGroup[];
  /** Potential risk notes (optional). */
  riskNotes?: string[];
  generatedAt: string;
  model: string;
}
