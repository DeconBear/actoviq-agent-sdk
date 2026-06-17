/**
 * Unified benchmark prompt.
 *
 * All agents receive the SAME instructions so the harness is the only variable
 * under test. Web-search phrasing is tool-agnostic: each harness uses whatever
 * web tool it has (Hadamard → TavilySearch, official Claude Code → WebSearch).
 */
import type { BenchmarkTask } from './types.js';

export function buildBenchmarkPrompt(task: BenchmarkTask, opts: { hasTeamTool: boolean }): string {
  const lines = [
    'Research and answer the question comprehensively.',
    'Use your web search capability (a web_search tool, or the Tavily search skill / tvly CLI if available) to find authoritative, up-to-date sources. Be efficient — quality over quantity.',
    '',
    'Your answer MUST:',
    '- Cover all key aspects of the question thoroughly',
    '- Include specific data, numbers, and concrete examples',
    '- Use tables and structured formatting where helpful',
    '- Include a "Sources:" section with markdown hyperlinks',
    '- Be COMPLETE — do not cut off mid-sentence',
    '',
  ];
  if (opts.hasTeamTool) {
    lines.push(
      'For large or complex aspects of this task you MAY consult the `expert-panel` tool: it runs independent read-only analyst models that research and return findings reports. It only advises — you stay in control and decide what (if anything) to incorporate. Use it when a second set of eyes genuinely helps; skip it otherwise.',
      '',
    );
  }
  lines.push(`QUESTION:\n${task.prompt}`);
  return lines.join('\n');
}

/**
 * Execution-track prompt: the agent works in a real project directory with full
 * tools and must actually make the change (not describe it) until the verifier passes.
 */
export function buildAgenticPrompt(task: BenchmarkTask, opts: { hasTeamTool: boolean }): string {
  const lines = [
    'You are working in a real project directory with full tools: read/write/edit files and run shell commands (Bash).',
    'Work autonomously and persistently until the task is COMPLETE and VERIFIED. Actually edit the files and run the verifier yourself; if it fails, read the output and keep fixing. Do NOT stop, summarize, defer, or hand back control until the success criterion below is met — keep taking actions (tool calls) until the verifier passes.',
    '',
    task.prompt,
    '',
  ];
  if (opts.hasTeamTool) {
    lines.push(
      'For hard diagnosis you MAY consult the `expert-panel` tool (independent read-only analysts) — advisory only; you make and verify the changes yourself.',
      '',
    );
  }
  if (task.verify) {
    lines.push(`Success criterion: the command \`${task.verify}\` must exit successfully.`);
  }
  return lines.join('\n');
}
