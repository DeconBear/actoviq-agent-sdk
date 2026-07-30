import { spawnSync } from 'node:child_process';

import type { SandboxCapabilityReport } from './types.js';

export function macosSandboxCapabilities(): SandboxCapabilityReport {
  const available = spawnSync('/usr/bin/sandbox-exec', ['-h'], {
    stdio: 'ignore',
  }).status !== null;
  return {
    platform: 'darwin',
    adapter: available ? 'macos-sandbox-exec' : 'portable-process',
    filesystemIsolation: available,
    networkIsolation: available,
    processTreeTermination: true,
    degraded: !available,
    ...(!available ? { reason: 'sandbox-exec is unavailable; only root validation and process-tree termination are available.' } : {}),
  };
}
