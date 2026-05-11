#!/usr/bin/env node
import('../dist/src/cli/actoviq-react.js').catch((e) => {
  console.error('Failed to start actoviq-react:', e);
  process.exit(1);
});
