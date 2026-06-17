/**
 * Fixed Scoring System — DeepSeek-v4-pro Judge
 * 5 dimensions, each 0-10. No DRACO PASS/FAIL, no truncation.
 */
import { resolveRuntimeConfig } from '../../src/config/resolveRuntimeConfig.js';
import { createActoviqModelApi } from '../../src/runtime/actoviqModelApi.js';
import { robustJsonParse } from '../../src/provider/json-parse.js';
import type { StandardScore } from './types.js';

const JUDGE_RUBRIC = `Score this answer on 5 dimensions (1-10 scale). Output ONLY a JSON object.

1. FACTUAL (1-10): Are facts, numbers, and claims correct and verifiable? Penalize hallucinations.
2. BREADTH (1-10): Does it cover all important aspects? Is analysis deep, not superficial?
3. STRUCTURE (1-10): Well-organized? Clear tables/headings? Easy to follow?
4. CITATION (1-10): Sources cited with URLs? References meaningful and relevant?
5. EFFICIENCY (1-10): Concise? No unnecessary repetition? Right length for the content?

Also provide a 1-2 sentence COMMENT on best quality and worst flaw.

{"factual":N,"breadth":N,"structure":N,"citation":N,"efficiency":N,"comment":"..."}`;

export async function scoreAnswer(
  answer: string,
  question: string,
  expectedCoverage?: string[],
): Promise<StandardScore> {
  const config = await resolveRuntimeConfig({ workDir: process.cwd(), model: 'deepseek-v4-pro' });
  const api = createActoviqModelApi(config);

  let text = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await api.createMessage({
      model: config.model,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        {
          role: 'user' as const,
          content: [
            `QUESTION:\n${question}`,
            expectedCoverage?.length ? `\nEXPECTED COVERAGE: ${expectedCoverage.join(', ')}` : '',
            `\nANSWER:\n${answer}`,
            `\n${JUDGE_RUBRIC}`,
          ].join('\n'),
        },
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

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0, overall: 0, judgeFailed: true };

  try {
    const parsed = robustJsonParse(match[0]);
    const f = clamp(Number(parsed.factual) || 0);
    const b = clamp(Number(parsed.breadth) || 0);
    const s = clamp(Number(parsed.structure) || 0);
    const c = clamp(Number(parsed.citation) || 0);
    const e = clamp(Number(parsed.efficiency) || 0);
    return {
      factual: f, breadth: b, structure: s, citation: c, efficiency: e,
      overall: Math.round((f * 0.30 + b * 0.25 + s * 0.20 + c * 0.15 + e * 0.10) * 10) / 10,
      comment: typeof parsed.comment === 'string' ? parsed.comment : undefined,
    };
  } catch {
    // Judge produced unparseable output — flag it so it can be excluded from
    // averages rather than silently scored as a (false) 0.
    return { factual: 0, breadth: 0, structure: 0, citation: 0, efficiency: 0, overall: 0, judgeFailed: true };
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n)));
}
