import { ConfigurationError } from '../errors.js';
import type { ActoviqModelTier, ActoviqModelTierConfig } from '../types.js';

export const ACTOVIQ_MODEL_TIERS: readonly ActoviqModelTier[] = [
  'min',
  'medium',
  'max',
];

export function isActoviqModelTier(value: string): value is ActoviqModelTier {
  return ACTOVIQ_MODEL_TIERS.includes(value.trim().toLowerCase() as ActoviqModelTier);
}

export function resolveActoviqModelReference(
  value: string,
  tiers: ActoviqModelTierConfig,
): { model: string; tier?: ActoviqModelTier } {
  const normalized = value.trim();
  if (!isActoviqModelTier(normalized)) {
    return { model: normalized };
  }

  const tier = normalized.toLowerCase() as ActoviqModelTier;
  const model = tiers[tier]?.trim();
  if (!model) {
    throw new ConfigurationError(
      `Model tier "${tier}" is not configured. Set ACTOVIQ_DEFAULT_${tier.toUpperCase()}_MODEL or pass a full model ID.`,
    );
  }
  return { model, tier };
}

export function selectDefaultActoviqModel(
  tiers: ActoviqModelTierConfig,
  fallbackModel: string,
): { model: string; tier?: ActoviqModelTier } {
  for (const tier of ['medium', 'max', 'min'] as const) {
    const model = tiers[tier]?.trim();
    if (model) {
      return { model, tier };
    }
  }
  return { model: fallbackModel };
}
