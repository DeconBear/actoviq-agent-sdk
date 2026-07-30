#!/usr/bin/env node
import {
  createActoviqCoreTools,
  createAgentSdk,
  loadDefaultActoviqSettings,
} from '../index.js';
import { AppServer } from './appServer.js';
import { StdioAppServerTransport } from './transports/stdioTransport.js';

async function main(): Promise<void> {
  await loadDefaultActoviqSettings();
  const workDir = process.argv[2] ? process.argv[2] : process.cwd();
  const sdk = await createAgentSdk({
    workDir,
    tools: createActoviqCoreTools({ cwd: workDir }),
    permissionMode: 'default',
  });
  const close = async () => {
    await sdk.close();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });
  try {
    await new StdioAppServerTransport(new AppServer(sdk)).start();
  } finally {
    await close();
  }
}

main().catch(error => {
  process.stderr.write(`actoviq-app-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
