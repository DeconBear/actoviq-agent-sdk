/**
 * Reviewer-track scorer — DeepSeek-v4-pro judge.
 *
 * Compares the reviewer's report to the ground-truth manifest and reports
 * RECALL (fraction of real bugs found) and PRECISION (found / found+false
 * positives). Precision is the reviewer's core contract: confirm only genuine,
 * verifiable issues — flagging a "trap" or inventing a bug costs precision.
 */
import { resolveRuntimeConfig } from '../../src/config/resolveRuntimeConfig.js';
import { createActoviqModelApi } from '../../src/runtime/actoviqModelApi.js';
import { robustJsonParse } from '../../src/provider/json-parse.js';
import type { ReviewManifest, ReviewScore } from './review-types.js';

export async function scoreReview(report: string, manifest: ReviewManifest): Promise<ReviewScore> {
  const config = await resolveRuntimeConfig({ workDir: process.cwd(), model: 'deepseek-v4-pro' });
  const api = createActoviqModelApi(config);

  const bugList = manifest.bugs.map((b) => `- ${b.id} @ ${b.location}: ${b.description}`).join('\n');
  const trapList =
    (manifest.traps ?? []).map((t) => `- ${t.id} @ ${t.location}: ${t.description}`).join('\n') || '(none)';

  const rubric = `You are grading a code reviewer's report against a ground-truth list of bugs.

GROUND-TRUTH BUGS (the reviewer SHOULD find each of these):
${bugList}

TRAPS — correct code that is NOT a bug (flagging any of these is a FALSE POSITIVE):
${trapList}

REVIEWER REPORT:
${report}

Rules:
- For each ground-truth bug, mark it found only if the report identifies the same defect/root cause (match by meaning, not wording; the location should roughly agree).
- falsePositives = the count of distinct issues the report asserts as real bugs that are NOT in the ground-truth list — including any trap it flags and any invented or incorrect claim. Do NOT count suggestions the report itself frames as optional/nice-to-have.

Output ONLY this JSON object:
{"found":["bug-id", "..."],"falsePositives":N,"comment":"1-2 sentence rationale"}`;

  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await api.createMessage({
      model: config.model,
      max_tokens: 1500,
      temperature: 0,
      messages: [
        { role: 'user' as const, content: rubric },
        ...(attempt > 0
          ? [
              { role: 'assistant' as const, content: text },
              { role: 'user' as const, content: 'OUTPUT ONLY THE JSON OBJECT. NO MARKDOWN.' },
            ]
          : []),
      ],
    });
    text = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (text.includes('{')) break;
  }

  const total = manifest.bugs.length;
  const allMissed = manifest.bugs.map((b) => b.id);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { found: [], missed: allMissed, falsePositives: 0, recall: 0, precision: 0, judgeFailed: true };
  }

  try {
    const parsed = robustJsonParse(match[0]);
    const validIds = new Set(manifest.bugs.map((b) => b.id));
    const found = [...new Set((Array.isArray(parsed.found) ? parsed.found.map(String) : []).filter((id) => validIds.has(id)))];
    const missed = manifest.bugs.filter((b) => !found.includes(b.id)).map((b) => b.id);
    const falsePositives = Math.max(0, Math.round(Number(parsed.falsePositives) || 0));
    const recall = total > 0 ? found.length / total : 0;
    const precision = found.length + falsePositives > 0 ? found.length / (found.length + falsePositives) : 1;
    return {
      found,
      missed,
      falsePositives,
      recall: Math.round(recall * 100) / 100,
      precision: Math.round(precision * 100) / 100,
      comment: typeof parsed.comment === 'string' ? parsed.comment : undefined,
    };
  } catch {
    return { found: [], missed: allMissed, falsePositives: 0, recall: 0, precision: 0, judgeFailed: true };
  }
}
