/**
 * Pricing data for major AI models.
 * Built-in table updated per release. Users can override via
 * ~/.actoviq/pricing.json: { "<model-slug>": { "input": <$/1M>, "output": <$/1M> } }
 */
import type { ModelPricing } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveActoviqHome } from '../config/actoviqHome.js';

/** $ per 1M tokens */
const BUILT_IN_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ──────────────────────────────────────────────────
  'claude-opus-4-8': { input: 15.0, output: 75.0 },
  'claude-opus-4-7': { input: 15.0, output: 75.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0 },
  'claude-fable-5': { input: 3.0, output: 15.0 },

  // ── OpenAI ─────────────────────────────────────────────────────
  'gpt-5.5': { input: 2.5, output: 10.0 },
  'gpt-5': { input: 2.5, output: 10.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'o3': { input: 10.0, output: 40.0 },

  // ── DeepSeek ───────────────────────────────────────────────────
  'deepseek-v4-pro': { input: 0.55, output: 2.19 },
  'deepseek-v3': { input: 0.27, output: 1.1 },
  'deepseek-r1': { input: 0.55, output: 2.19 },

  // ── Google ─────────────────────────────────────────────────────
  'gemini-3-flash': { input: 0.1, output: 0.4 },
  'gemini-3-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },

  // ── MiniMax ─────────────────────────────────────────────────────
  'MiniMax-M3': { input: 0.5, output: 2.0 },
  'MiniMax-M2': { input: 0.3, output: 1.2 },

  // ── Kimi / Moonshot ────────────────────────────────────────────
  'kimi-k2.6': { input: 0.6, output: 2.4 },
  'kimi-k2': { input: 0.6, output: 2.4 },
};

function resolvePricingPath(homeDir?: string): string {
  return path.join(resolveActoviqHome(homeDir), 'pricing.json');
}

let _userPricing: Record<string, ModelPricing> | null = null;
let _userPricingLoaded = false;

function loadUserPricing(homeDir?: string): Record<string, ModelPricing> {
  if (_userPricingLoaded) return _userPricing ?? {};
  _userPricingLoaded = true;
  try {
    const p = resolvePricingPath(homeDir);
    if (fs.existsSync(p)) {
      _userPricing = JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch {
    // Missing or malformed — ignore
  }
  return _userPricing ?? {};
}

/** Get pricing for a model. Returns null if unavailable. */
export function getModelPricing(model: string, homeDir?: string): ModelPricing | null {
  const user = loadUserPricing(homeDir);
  if (user[model]) return user[model];
  return BUILT_IN_PRICING[model] ?? null;
}

/** Compute cost from token counts. Returns null if pricing unavailable. */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  homeDir?: string,
): number | null {
  const pricing = getModelPricing(model, homeDir);
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/** Check if all models in a list have pricing data. */
export function hasFullPricing(models: string[], homeDir?: string): boolean {
  return models.every((m) => getModelPricing(m, homeDir) !== null);
}

/** Clear cached user pricing (for testing). */
export function clearPricingCache(): void {
  _userPricing = null;
  _userPricingLoaded = false;
}
