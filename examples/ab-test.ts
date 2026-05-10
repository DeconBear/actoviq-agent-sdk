/**
 * A/B test: volcano HTML prompt on clean SDK vs bridge SDK
 */
import {
  createAgentSdk,
  loadDefaultActoviqSettings,
  createActoviqBridgeSdk,
  createActoviqFileTools,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const prompt =
  'Write a file named volcano.html. The content should be a complete HTML page ' +
  'with a volcano eruption animation using canvas. Include particle effects for lava, ' +
  'ash clouds, and glowing embers. Add a slider to control eruption intensity. ' +
  'Make it look beautiful with a dark sky background and glowing lava. ' +
  'Keep the HTML self-contained (inline CSS and JS). Explain what you did.';

const tools = createActoviqFileTools({ cwd: process.cwd() });

function logEvent(label: string, event: any) {
  if (event.type === 'response.text.delta') {
    const text = typeof event.delta === 'string' ? event.delta : event.delta?.text ?? '';
    process.stdout.write(text);
  }
  if (event.type === 'tool.call') {
    const input = JSON.stringify(event.call?.input ?? event.input ?? {});
    console.log(`\n[${label} TOOL] ${event.call?.name ?? event.name}: ${input.slice(0, 150)}`);
  }
  if (event.type === 'tool.result') {
    console.log(`[${label} RESULT] isError=${event.result?.isError ?? false}`);
  }
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') {
        console.log(`\n[${label} TOOL] ${block.name}: ${JSON.stringify(block.input).slice(0, 150)}`);
      }
    }
  }
  if (event.type === 'result') {
    console.log(`\n[${label} END] turns=${(event as any).numTurns} stop=${(event as any).subtype}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Test 1: Clean SDK
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== CLEAN SDK ===');
console.log(`model: ${(await createAgentSdk()).config.model}`);

const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'AB clean' });
const stream = session.stream(prompt, {
  tools, maxToolIterations: 10,
  systemPrompt: 'You are an interactive CLI agent. Use tools to accomplish tasks. Write complete, working code.',
});

let cleanToolCalls = 0;
let cleanErrors = 0;
for await (const event of stream) {
  logEvent('CLEAN', event);
  if (event.type === 'tool.call') cleanToolCalls++;
  if (event.type === 'tool.result' && event.result.isError) cleanErrors++;
}
const r1 = await stream.result;
console.log(`\n--- Clean SDK: ${r1.requests.length} iterations, ${cleanToolCalls} tool calls, ${cleanErrors} errors ---\n`);
await sdk.close();

// ═══════════════════════════════════════════════════════════════════════
//  Test 2: Bridge SDK
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== BRIDGE SDK ===');

const bsdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  permissionMode: 'bypassPermissions',
  dangerouslySkipPermissions: true,
  includePartialMessages: true,
  maxTurns: 10,
});

const bsession = await bsdk.createSession({
  title: 'AB bridge',
  permissionMode: 'bypassPermissions',
  dangerouslySkipPermissions: true,
  includePartialMessages: true,
  maxTurns: 10,
});

let bridgeToolCalls = 0;
const bstream = bsession.stream(prompt);
for await (const event of bstream) {
  logEvent('BRIDGE', event);
  if ((event.type === 'assistant' && (event as any).message?.content?.some((b: any) => b.type === 'tool_use')) || event.type === 'tool.call') bridgeToolCalls++;
}
const r2 = await bstream.result;
console.log(`\n--- Bridge SDK: ${bridgeToolCalls} tool calls ---\n`);
await bsdk.close();

console.log('\n=== COMPARISON ===');
console.log(`Clean:  ${cleanToolCalls} tool calls, ${cleanErrors} errors`);
console.log(`Bridge: ${bridgeToolCalls} tool calls`);
