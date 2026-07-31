#!/usr/bin/env node
import('../dist/src/cli/hadamard-tui.js').catch((e) => {
  console.error('Failed to start hadamard-tui:', e);
  process.exit(1);
});
