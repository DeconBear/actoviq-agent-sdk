#!/usr/bin/env node
import('../dist/src/cli/hadamard-react.js').catch((e) => {
  console.error('Failed to start hadamard-react:', e);
  process.exit(1);
});
