/**
 * Example: Clean SDK ReAct loop.
 *
 * Demonstrates a one-shot ReAct interaction with streaming output,
 * tool calls, and thinking blocks. For the full interactive REPL,
 * use the `actoviq-react` command.
 *
 * Usage: npm run example:actoviq-react-loop
 */
import { createAgentSdk, loadDefaultActoviqSettings, createActoviqCoreTools } from 'actoviq-agent-sdk';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

await loadDefaultActoviqSettings();

const WORK_DIR = path.resolve(process.argv[2] ?? process.cwd());
const sdk = await createAgentSdk({ workDir: WORK_DIR, maxToolIterations: 15 });
const tools = createActoviqCoreTools({ cwd: WORK_DIR });

const isGit = (() => {
  try { execSync('git rev-parse --is-inside-work-tree', { cwd: WORK_DIR, stdio: 'ignore' }); return true; }
  catch { return false; }
})();

const SYSTEM_PROMPT = `You are an interactive CLI agent. Working directory: ${WORK_DIR}.
<env>
Working directory: ${WORK_DIR}
Is git repo: ${isGit ? 'Yes' : 'No'}
Platform: ${process.platform}
</env>
# Guidelines
- Prefer editing existing files to creating new ones.
- Default to writing no comments.
- Never destructive git commands unless requested.
- Never create *.md files unless explicitly requested.`;

const session = await sdk.createSession({ title: `ReAct — ${path.basename(WORK_DIR)}` });

const prompt = process.argv[3] ?? 'List the files in the current directory.';
console.log(`\n> ${prompt}\n`);

const stream = session.stream(prompt, { tools, systemPrompt: SYSTEM_PROMPT });
let iteration = 0;

for await (const event of stream) {
  switch (event.type) {
    case 'request.started':
      iteration = event.iteration;
      if (iteration > 1) console.log(`\n── iteration ${iteration} ──`);
      break;
    case 'response.text.delta':
      process.stdout.write(typeof event.delta === 'string' ? event.delta : (event.delta as any)?.text ?? '');
      break;
    case 'response.content':
      if (event.content.type === 'thinking') {
        console.log(`\n💭 ${((event.content as any).thinking ?? '').slice(0, 200)}`);
      }
      break;
    case 'tool.call':
      console.log(`\n  ⚡ ${event.call.name}(${JSON.stringify(event.call.input).slice(0, 100)})`);
      break;
    case 'tool.result':
      console.log(`  ${event.result.isError ? '✗' : '✓'} (${event.result.durationMs}ms)`);
      break;
    case 'error':
      console.log(`\n  ✕ ${event.error.message}`);
      break;
  }
}

const result = await stream.result;
console.log(`\n\n[Done: ${result.requests.length} reqs, ${result.toolCalls.length} tools, stop: ${result.stopReason}]`);
await sdk.close();
