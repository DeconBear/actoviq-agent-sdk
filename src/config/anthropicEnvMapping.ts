/**
 * Maps Actoviq settings env keys (`~/.actoviq/settings.json` → `env` block)
 * to the `ANTHROPIC_*` variables understood by Claude Code-based runtimes
 * (the Bridge runtime bundle and the official Claude Agent SDK CLI).
 *
 * This keeps `~/.actoviq/settings.json` as the single source of model/credential
 * configuration: without the mapping, Claude Code-based child processes silently
 * fall back to `~/.claude/settings.json` or keychain OAuth credentials.
 */

const DIRECT_KEY_MAPPING: ReadonlyArray<readonly [actoviqKey: string, anthropicKey: string]> = [
  ['ACTOVIQ_API_KEY', 'ANTHROPIC_API_KEY'],
  ['ACTOVIQ_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  ['ACTOVIQ_BASE_URL', 'ANTHROPIC_BASE_URL'],
  ['ACTOVIQ_MODEL', 'ANTHROPIC_MODEL'],
  ['ACTOVIQ_DEFAULT_medium_MODEL', 'ANTHROPIC_DEFAULT_medium_MODEL'],
  ['ACTOVIQ_DEFAULT_max_MODEL', 'ANTHROPIC_DEFAULT_max_MODEL'],
  ['ACTOVIQ_DEFAULT_min_MODEL', 'ANTHROPIC_DEFAULT_min_MODEL'],
];

/**
 * Derive `ANTHROPIC_*` variables from Actoviq-style env entries.
 *
 * Explicit `ANTHROPIC_*` keys in the source env always win over derived values.
 * `ACTOVIQ_DEFAULT_min_MODEL` additionally feeds `ANTHROPIC_SMALL_FAST_MODEL`
 * so background/fast-path requests stay on the configured provider.
 */
export function mapActoviqEnvToAnthropicEnv(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  const mapped: Record<string, string> = {};

  for (const [actoviqKey, anthropicKey] of DIRECT_KEY_MAPPING) {
    const value = sourceEnv[actoviqKey];
    if (value && !sourceEnv[anthropicKey]) {
      mapped[anthropicKey] = value;
    }
  }

  const haikuModel = sourceEnv.ACTOVIQ_DEFAULT_min_MODEL;
  if (haikuModel && !sourceEnv.ANTHROPIC_SMALL_FAST_MODEL) {
    mapped.ANTHROPIC_SMALL_FAST_MODEL = haikuModel;
  }

  return mapped;
}
