#!/usr/bin/env node
import('../dist/src/cli/bridge-interactive-agent.js').catch((e) => {
  console.error('Failed to start hadamard-interactive-agent:', e);
  process.exit(1);
});
