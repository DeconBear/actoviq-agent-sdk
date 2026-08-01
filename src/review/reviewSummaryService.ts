import type { ReviewSummary, ReviewSemanticGroup, ReviewChangeImpact } from './types.js';

const MAX_DIFF_CHARS = 60_000;

const VALID_IMPACTS: ReadonlySet<string> = new Set<ReviewChangeImpact>([
  'added',
  'modified',
  'removed',
  'refactored',
]);

/**
 * Build the prompt that instructs the model to produce a structured
 * ReviewSummary JSON from a unified diff.
 */
export function buildReviewPrompt(diff: string): string {
  const capped = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n...[diff truncated]...'
    : diff;

  return [
    'You are a code review assistant. Analyze the following git diff and produce a structured summary',
    'that a non-programmer (designer, product manager) can understand.',
    '',
    'Rules:',
    '- Group changes by USER-PERCEIVABLE BEHAVIOUR, not by file.',
    '- Each group title should describe what changed from the user\'s perspective.',
    '- Use plain language; avoid jargon when possible.',
    '- "impact" must be one of: "added", "modified", "removed", "refactored".',
    '- "riskNotes" is optional: include only if there are genuine risks (breaking changes, security).',
    '- Respond with ONLY valid JSON matching this schema (no markdown fences, no commentary):',
    '',
    '{',
    '  "headline": "<one-line summary of all changes>",',
    '  "groups": [',
    '    {',
    '      "title": "<behaviour change title>",',
    '      "impact": "added|modified|removed|refactored",',
    '      "description": "<2-3 sentence explanation>",',
    '      "files": [',
    '        { "path": "<file path>", "impact": "added|modified|removed|refactored", "summary": "<one sentence>" }',
    '      ]',
    '    }',
    '  ],',
    '  "riskNotes": ["<optional risk>"]',
    '}',
    '',
    '--- BEGIN DIFF ---',
    capped,
    '--- END DIFF ---',
  ].join('\n');
}

/**
 * Parse the model's raw text response into a ReviewSummary.
 * Handles: pure JSON, JSON wrapped in markdown code fences, JSON with
 * surrounding commentary text.
 */
export function parseReviewSummary(raw: string, model = 'unknown'): ReviewSummary {
  const json = extractJson(raw);
  if (!json) return fallbackSummary(raw, model);

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const headline = typeof parsed.headline === 'string' ? parsed.headline : 'Changes detected';
    const groups = normalizeGroups(parsed.groups);
    const riskNotes = Array.isArray(parsed.riskNotes)
      ? parsed.riskNotes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      : undefined;

    return {
      headline,
      groups,
      ...(riskNotes && riskNotes.length > 0 ? { riskNotes } : {}),
      generatedAt: new Date().toISOString(),
      model,
    };
  } catch {
    return fallbackSummary(raw, model);
  }
}

/**
 * Orchestrate: build prompt -> call model -> parse response.
 */
export async function generateReviewSummary(options: {
  diff: string;
  model: string;
  oneShotMessage: (request: {
    system?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }) => Promise<string>;
  signal?: AbortSignal;
}): Promise<ReviewSummary> {
  const prompt = buildReviewPrompt(options.diff);
  const raw = await options.oneShotMessage({
    system: 'You are a concise code review summarizer. Output only valid JSON.',
    prompt,
    maxTokens: 2048,
    temperature: 0.3,
    signal: options.signal,
  });
  return parseReviewSummary(raw, options.model);
}

// --- Internal helpers ---

function extractJson(raw: string): string | null {
  // Try markdown code fence first: ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Try to find a top-level JSON object
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return null;
}

function normalizeGroups(raw: unknown): ReviewSemanticGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item): ReviewSemanticGroup => {
    const obj = (item ?? {}) as Record<string, unknown>;
    return {
      title: typeof obj.title === 'string' ? obj.title : 'Untitled change',
      impact: normalizeImpact(obj.impact),
      description: typeof obj.description === 'string' ? obj.description : '',
      files: Array.isArray(obj.files)
        ? obj.files.map((f): ReviewSemanticGroup['files'][number] => {
            const file = (f ?? {}) as Record<string, unknown>;
            return {
              path: typeof file.path === 'string' ? file.path : 'unknown',
              impact: normalizeImpact(file.impact),
              summary: typeof file.summary === 'string' ? file.summary : '',
            };
          })
        : [],
    };
  });
}

function normalizeImpact(value: unknown): ReviewChangeImpact {
  return typeof value === 'string' && VALID_IMPACTS.has(value)
    ? (value as ReviewChangeImpact)
    : 'modified';
}

function fallbackSummary(raw: string, model: string): ReviewSummary {
  const trimmed = raw.trim().slice(0, 500);
  return {
    headline: trimmed.split('\n')[0] || 'Changes detected',
    groups: [{
      title: 'Changes',
      impact: 'modified',
      description: trimmed,
      files: [],
    }],
    generatedAt: new Date().toISOString(),
    model,
  };
}
