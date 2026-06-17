/**
 * Key preload — MUST be the first import in run-all.ts.
 *
 * Loads bench/.bench-keys.json into process.env BEFORE the runner modules are
 * evaluated, so module-level reads (e.g. runner-hadamard's MINIMAX_API_KEY) and
 * the spawned `claude -p` child both see the keys. Only sets vars that are not
 * already present, so real environment variables always win.
 */
import fs from 'node:fs';
import path from 'node:path';

function setIfMissing(key: string, value: string | undefined): void {
  if (value && !process.env[key]) process.env[key] = value;
}

try {
  const keysPath = path.join(process.cwd(), 'bench', '.bench-keys.json');
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8')) as Record<string, string>;
  setIfMissing('MINIMAX_API_KEY', keys.MINIMAX_API_KEY);
  setIfMissing('TAVILY_API_KEY', keys.TAVILY_API_KEY);
  setIfMissing('DEEPSEEK_API_KEY', keys.DEEPSEEK_API_KEY);
  // Make the in-process SDK (Hadamard agents, panel members, the judge) able to
  // authenticate directly from env — no dependency on loadDefaultActoviqSettings
  // having run first.
  setIfMissing('ACTOVIQ_AUTH_TOKEN', keys.DEEPSEEK_API_KEY);
  setIfMissing('ACTOVIQ_BASE_URL', 'https://api.deepseek.com/anthropic');
  // Route the official `claude -p` runner to the same DeepSeek endpoint as the
  // other agents, so the benchmark compares harnesses on one held-constant model.
  setIfMissing('ANTHROPIC_BASE_URL', 'https://api.deepseek.com/anthropic');
  setIfMissing('ANTHROPIC_AUTH_TOKEN', keys.DEEPSEEK_API_KEY);
} catch {
  // bench-keys is optional; settings.json / real env may already supply keys.
}
