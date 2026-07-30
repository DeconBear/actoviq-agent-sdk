import { spawnSync } from 'node:child_process';

import type { SandboxCapabilityReport } from './types.js';

export function linuxSandboxCapabilities(): SandboxCapabilityReport {
  const available = spawnSync('bwrap', ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
  }).status === 0;
  return {
    platform: 'linux',
    adapter: available ? 'linux-bubblewrap' : 'portable-process',
    filesystemIsolation: available,
    networkIsolation: available,
    processTreeTermination: true,
    degraded: !available,
    ...(!available ? { reason: 'bubblewrap is not installed; only root validation and process-tree termination are available.' } : {}),
  };
}
