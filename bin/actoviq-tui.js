#!/usr/bin/env node
import('../dist/src/cli/actoviq-tui.js').catch((e) => {
  console.error('Failed to start actoviq-tui:', e);
  process.exit(1);
});
