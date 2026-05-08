#!/usr/bin/env node
// Bootstrap wrapper: loads ESM cli.js entry point.
// npm generates proper CMD/PS1 wrappers for .cjs files on Windows.
import('../dist/cli.js').catch((e) => {
  console.error('Failed to start actoviq:', e);
  process.exit(1);
});
