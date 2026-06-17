export const meta = {
  name: 'expert-orchestration',
  description: 'Hardcoded orchestration: a read-only expert panel analyzes, a full-permission sub-agent executes, then re-evaluate and loop until done. Optional alternative to letting the main model call the expert-panel tool autonomously.',
  phases: [
    { title: 'Analyze' },
    { title: 'Execute' },
    { title: 'Re-evaluate' },
  ],
};

const task = typeof args === 'string'
  ? args
  : (args && (args.task || args.prompt)) || '';
const maxCycles = (args && args.maxCycles) || 3;
const READONLY = ['Read', 'Glob', 'Grep', 'TavilySearch', 'WebFetch'];

if (!task) {
  log('No task provided. Run: /workflows run expert-orchestration <task>');
  return 'No task provided.';
}

let output = '';
let guidance = '';

for (let cycle = 1; cycle <= maxCycles; cycle++) {
  // ── Analyze: read-only expert panel (parallel, independent) ────────
  phase('Analyze');
  log(`Cycle ${cycle}/${maxCycles}: expert panel analyzing (read-only)...`);
  const reports = await parallel([
    () => agent(
      `You are a RIGOROUS ANALYST on a read-only expert panel. Investigate the task using only read tools (Read/Glob/Grep) and web search (TavilySearch/WebFetch). Verify every claim against real sources, flag risks and blind spots, and give concrete, decision-useful recommendations. Do NOT fabricate references.\n\nTask:\n${task}\n${guidance ? '\nThis cycle, focus on:\n' + guidance : ''}`,
      { tools: READONLY, phase: 'Analyze' },
    ),
    () => agent(
      `You are an EXPERT RESEARCHER on a read-only expert panel. Investigate the task using read tools and web search. Produce a comprehensive, source-grounded analysis with specifics. Do NOT fabricate references.\n\nTask:\n${task}\n${guidance ? '\nThis cycle, focus on:\n' + guidance : ''}`,
      { tools: READONLY, phase: 'Analyze' },
    ),
  ]);
  const findings = reports
    .map((r, i) => (r ? `### Analyst ${i + 1}\n${r}` : `### Analyst ${i + 1}\n[no report]`))
    .join('\n\n---\n\n');

  // ── Execute: full-permission sub-agent (all tools) ─────────────────
  phase('Execute');
  log(`Cycle ${cycle}/${maxCycles}: sub-agent executing (full tools)...`);
  output = await agent(
    `Produce the complete deliverable for this task. You have full tools. Use the expert panel's findings to ground your work, but verify them — do not blindly trust, and never copy fabricated claims.\n\nTask:\n${task}\n\nExpert panel findings:\n${findings}\n${output ? '\nYour previous draft to revise and improve:\n' + output : ''}`,
    { phase: 'Execute' },
  );

  // ── Re-evaluate: panel-style critique decides loop vs done ─────────
  phase('Re-evaluate');
  const verdict = await agent(
    `Critically evaluate the deliverable against the task. If it fully and correctly satisfies the task, respond with exactly "DONE" on the first line. Otherwise respond with "CONTINUE" on the first line, then specific guidance for what the next cycle must fix or add.\n\nTask:\n${task}\n\nDeliverable:\n${output}`,
    { tools: READONLY, phase: 'Re-evaluate' },
  );
  if (verdict.trim().toUpperCase().startsWith('DONE')) {
    log(`Converged after cycle ${cycle}.`);
    break;
  }
  guidance = verdict.replace(/^\s*CONTINUE\s*/i, '').trim();
  log(`Cycle ${cycle}: continuing — ${guidance.slice(0, 160)}`);
}

return output;
