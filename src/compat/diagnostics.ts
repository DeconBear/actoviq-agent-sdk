export interface CompatDiagnostic {
  readonly symbol: string;
  readonly count: number;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
}

export interface CompatDiagnosticsOptions {
  readonly enabled?: boolean;
  readonly warnOnce?: boolean;
  readonly onDiagnostic?: (diagnostic: CompatDiagnostic) => void;
}

const diagnostics = new Map<string, CompatDiagnostic>();
const warned = new Set<string>();
let options: Required<Pick<CompatDiagnosticsOptions, 'enabled' | 'warnOnce'>>
  & Pick<CompatDiagnosticsOptions, 'onDiagnostic'> = {
    enabled: true,
    warnOnce: false,
  };

/** Configure process-local migration telemetry. No network or persistence is used. */
export function configureCompatDiagnostics(next: CompatDiagnosticsOptions): void {
  options = {
    enabled: next.enabled ?? options.enabled,
    warnOnce: next.warnOnce ?? options.warnOnce,
    onDiagnostic: next.onDiagnostic ?? options.onDiagnostic,
  };
}

export function recordCompatUsage(symbol: string): void {
  if (!options.enabled) return;
  const normalized = symbol.trim();
  if (!normalized) throw new TypeError('Compatibility symbol must not be empty.');
  const now = new Date().toISOString();
  const previous = diagnostics.get(normalized);
  const diagnostic: CompatDiagnostic = Object.freeze({
    symbol: normalized,
    count: (previous?.count ?? 0) + 1,
    firstUsedAt: previous?.firstUsedAt ?? now,
    lastUsedAt: now,
  });
  diagnostics.set(normalized, diagnostic);
  options.onDiagnostic?.(diagnostic);
  if (options.warnOnce && !warned.has(normalized)) {
    warned.add(normalized);
    process.emitWarning(
      `${normalized} is provided by the compatibility façade; migrate via the documented subpath APIs.`,
      { code: 'ACTOVIQ_COMPAT_API' },
    );
  }
}

export function getCompatDiagnostics(): readonly CompatDiagnostic[] {
  return Object.freeze([...diagnostics.values()]
    .map(value => Object.freeze({ ...value }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol)));
}

/** Test/host lifecycle hook; not exported from the package root. */
export function resetCompatDiagnostics(): void {
  diagnostics.clear();
  warned.clear();
  options = { enabled: true, warnOnce: false };
}
