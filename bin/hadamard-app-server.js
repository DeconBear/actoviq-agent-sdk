#!/usr/bin/env node
import('../dist/src/app-server/cli.js').catch(error => {
  console.error('Failed to start hadamard-app-server:', error);
  process.exit(1);
});
