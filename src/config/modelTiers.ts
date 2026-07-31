import { ConfigurationError } from '../errors.js';
import type { HadamardModelTier, HadamardModelTierConfig } from '../types.js';

export const HADAMARD_MODEL_TIERS: readonly HadamardModelTier[] = [
  'min',
  'medium',
  'max',
];

export function isHadamardModelTier(value: string): value is HadamardModelTier {
  return HADAMARD_MODEL_TIERS.includes(value.trim().toLowerCase() as HadamardModelTier);
}

export function resolveHadamardModelReference(
  value: string,
  tiers: HadamardModelTierConfig,
): { model: string; tier?: HadamardModelTier } {
  const normalized = value.trim();
  if (!isHadamardModelTier(normalized)) {
    return { model: normalized };
  }

  const tier = normalized.toLowerCase() as HadamardModelTier;
  const model = tiers[tier]?.trim();
  if (!model) {
    throw new ConfigurationError(
      `Model tier "${tier}" is not configured. Set HADAMARD_DEFAULT_${tier.toUpperCase()}_MODEL or pass a full model ID.`,
    );
  }
  return { model, tier };
}

export function selectDefaultHadamardModel(
  tiers: HadamardModelTierConfig,
  fallbackModel: string,
): { model: string; tier?: HadamardModelTier } {
  for (const tier of ['medium', 'max', 'min'] as const) {
    const model = tiers[tier]?.trim();
    if (model) {
      return { model, tier };
    }
  }
  return { model: fallbackModel };
}
