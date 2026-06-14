/**
 * Maps Actoviq settings env keys (`~/.actoviq/settings.json` → `env` block)
 * to the `ANTHROPIC_*` variables understood by Claude Code-based runtimes
 * (the Bridge runtime bundle and the official Claude Agent SDK CLI).
 *
 * This keeps `~/.actoviq/settings.json` as the single source of model/credential
 * configuration: without the mapping, Claude Code-based child processes silently
 * fall back to `~/.claude/settings.json` or keychain OAuth credentials.
 */

import {
  isActoviqModelTier,
  selectDefaultActoviqModel,
} from './modelTiers.js';

const DIRECT_KEY_MAPPING: ReadonlyArray<readonly [actoviqKey: string, anthropicKey: string]> = [
  ['ACTOVIQ_API_KEY', 'ANTHROPIC_API_KEY'],
  ['ACTOVIQ_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  ['ACTOVIQ_BASE_URL', 'ANTHROPIC_BASE_URL'],
];

/**
 * Derive `ANTHROPIC_*` variables from Actoviq-style env entries.
 *
 * Explicit `ANTHROPIC_*` keys in the source env always win over derived values.
 * `ACTOVIQ_DEFAULT_MIN_MODEL` additionally feeds `ANTHROPIC_SMALL_FAST_MODEL`
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

  const modelTiers = {
    min: sourceEnv.ACTOVIQ_DEFAULT_MIN_MODEL,
    medium: sourceEnv.ACTOVIQ_DEFAULT_MEDIUM_MODEL,
    max: sourceEnv.ACTOVIQ_DEFAULT_MAX_MODEL,
  };
  const requestedModel = sourceEnv.ACTOVIQ_MODEL?.trim();
  const mappedModel =
    requestedModel && isActoviqModelTier(requestedModel)
      ? modelTiers[requestedModel.toLowerCase() as keyof typeof modelTiers]
      : requestedModel || selectDefaultActoviqModel(modelTiers, '').model;
  if (mappedModel && !sourceEnv.ANTHROPIC_MODEL) {
    mapped.ANTHROPIC_MODEL = mappedModel;
  }

  const minModel = sourceEnv.ACTOVIQ_DEFAULT_MIN_MODEL;
  if (minModel && !sourceEnv.ANTHROPIC_SMALL_FAST_MODEL) {
    mapped.ANTHROPIC_SMALL_FAST_MODEL = minModel;
  }

  return mapped;
}
