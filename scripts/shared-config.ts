/**
 * Shared benchmark configuration — reads keys from bench/.bench-keys.json
 * This file is gitignored, never committed.
 */
import fs from 'node:fs';
import path from 'node:path';

function loadBenchKeys(): Record<string, string> {
  try {
    const p = path.join(process.cwd(), 'bench', '.bench-keys.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

const keys = loadBenchKeys();

export const MINIMAX_KEY = process.env.MINIMAX_API_KEY || keys.MINIMAX_API_KEY || '';
export const TAVILY_KEY  = process.env.TAVILY_API_KEY  || keys.TAVILY_API_KEY  || '';
export const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || keys.DEEPSEEK_API_KEY || process.env.ACTOVIQ_AUTH_TOKEN || '';

// Model configurations (max context/output per official docs)
export const MODELS = {
  'MiniMax-M3':      { maxOutput: 131072, context: 1_000_000, provider: 'anthropic' as const, baseURL: 'https://api.minimaxi.com/anthropic/v1' },
  'deepseek-v4-pro': { maxOutput: 384000, context: 1_000_000, provider: 'anthropic' as const, baseURL: 'https://api.deepseek.com/anthropic/v1' },
} as const;

if (!MINIMAX_KEY && !keys.MINIMAX_API_KEY) console.warn('[shared-config] MINIMAX_API_KEY not found. Team mode will fail.');
