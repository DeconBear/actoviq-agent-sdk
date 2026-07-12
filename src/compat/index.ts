/** Existing 0.x API surface retained as the compatibility façade. */
export * from '../index.js';

export type { LegacyModelApiProviderOptions } from '../providers-v2/legacy.js';
export {
  LegacyModelApiProvider,
  ModelProviderLegacyAdapter,
} from '../providers-v2/legacy.js';
export {
  configureCompatDiagnostics,
  getCompatDiagnostics,
} from './diagnostics.js';
export type {
  CompatDiagnostic,
  CompatDiagnosticsOptions,
} from './diagnostics.js';
export * from '../surfaces/index.js';
