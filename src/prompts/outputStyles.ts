/**
 * Output styles — a prompt-prefix swap that adjusts the agent's response
 * shape, mirroring Claude Code's /output-style. A non-empty prefix is
 * prepended to the system prompt on each turn.
 *
 * `default` is the empty prefix (no behavior change). The styles below are the
 * built-ins; the list drives the /output-style picker.
 */
export type OutputStyleId = 'default' | 'concise' | 'explanatory' | 'learning';

export interface OutputStyle {
  id: OutputStyleId;
  label: string;
  description: string;
  prefix: string;
}

export const OUTPUT_STYLES: OutputStyle[] = [
  {
    id: 'default',
    label: 'default',
    description: 'No style override — standard responses',
    prefix: '',
  },
  {
    id: 'concise',
    label: 'concise',
    description: 'Terse, code-first; minimal prose',
    prefix:
      'Respond concisely. Prefer code over prose. Omit pleasantries, restatements of the question, and summary lines. Lead with the direct answer or the code change; add a one-line rationale only when non-obvious.',
  },
  {
    id: 'explanatory',
    label: 'explanatory',
    description: 'Explain reasoning and tradeoffs',
    prefix:
      'Respond with explanatory depth. State your reasoning, the alternatives you considered, and the tradeoffs of your choice. Surface assumptions. Still be correct and complete — depth is the goal, not length for its own sake.',
  },
  {
    id: 'learning',
    label: 'learning',
    description: 'Teach the user how/why, step by step',
    prefix:
      'Adopt a teaching posture. Explain how and why, step by step, as if helping the user build the skill rather than just handing over the answer. Call out the relevant concept or pattern. Keep it grounded — teach via the actual code/decision at hand.',
  },
];

export function getOutputStyle(id: OutputStyleId): OutputStyle {
  return OUTPUT_STYLES.find((s) => s.id === id) ?? OUTPUT_STYLES[0]!;
}

/** Prepend the active style prefix to a base system prompt (no-op for default). */
export function applyOutputStyle(baseSystemPrompt: string, style: OutputStyleId): string {
  const prefix = getOutputStyle(style).prefix;
  return prefix ? `${prefix}\n\n${baseSystemPrompt}` : baseSystemPrompt;
}
