import type { SandboxCapabilityReport } from './types.js';

export function windowsSandboxCapabilities(): SandboxCapabilityReport {
  return {
    platform: 'win32',
    adapter: 'windows-restricted-process',
    filesystemIsolation: false,
    networkIsolation: false,
    processTreeTermination: true,
    degraded: true,
    reason: 'Restricted-token filesystem/network isolation is unavailable in this build; root validation and process-tree termination remain enforced.',
  };
}
