/**
 * Reviewer-track benchmark types.
 *
 * Tests the `reviewer` team mode on bug-detection: a fixture ships code with
 * planted, verifiable bugs (and optional "traps" — correct-but-suspicious code).
 * The reviewer inspects the workspace read-only and reports issues; an LLM judge
 * scores it against the ground-truth manifest on RECALL (did it find the real
 * bugs?) and PRECISION (did it avoid false positives — the reviewer's core
 * "confirm only genuine issues" contract).
 */
export interface ReviewBug {
  id: string;
  /** Where the bug lives, e.g. "csv.js: parseLine". */
  location: string;
  /** What is actually wrong (the verifiable defect). */
  description: string;
}

/**
 * `review-manifest.json` inside a fixture. The reviewer only sees `task` +
 * `context` (and the code); `bugs`/`traps` are ground truth for the judge and
 * are NOT copied into the reviewer's workspace.
 */
export interface ReviewManifest {
  title: string;
  /** What the reviewer is asked to check. */
  task: string;
  /** What the requesting agent did + the results it obtained (→ reviewer system prompt). */
  context: string;
  /** Genuine, verifiable bugs the reviewer should find. */
  bugs: ReviewBug[];
  /** Correct-but-suspicious code; flagging any of these is a false positive. */
  traps?: ReviewBug[];
}

export interface ReviewScore {
  /** Bug ids the reviewer correctly identified. */
  found: string[];
  /** Bug ids it missed. */
  missed: string[];
  /** Issues it claimed that are not real bugs (includes trap hits). */
  falsePositives: number;
  /** found / total bugs (0..1). */
  recall: number;
  /** found / (found + falsePositives) (0..1); 1 when it claimed nothing false. */
  precision: number;
  comment?: string;
  /** True if the judge produced unparseable output (exclude from averages). */
  judgeFailed?: boolean;
}

export interface ReviewRunMetrics {
  durationMs: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReviewAgent {
  name: string;
  label: string;
  model: string;
}
