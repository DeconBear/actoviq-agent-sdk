/**
 * Lightweight global session history (mirrors Codex's `~/.codex/history.jsonl`
 * and Claude Code's `~/.claude/history.jsonl`).
 *
 * Append-only JSONL — one line per user turn, minimal metadata. Used for
 * cross-session search and resume-picker previews. Trimmed to a soft cap
 * so the file stays compact.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_HISTORY_BYTES = 512_000; // ~500 KB soft limit
const SOFT_CAP_RATIO = 0.8;       // trim back to this fraction when over the cap

export interface HistoryEntry {
  sessionId: string;
  /** Unix timestamp in seconds. */
  ts: number;
  text: string;
  /** If the turn was answered by a bridge/routed model, which one. */
  model?: string;
}

function historyPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.actoviq', 'history.jsonl');
}

function ensureDir(dir: string): void {
  try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
}

/** Append one turn to the global history file. */
export function recordTurn(entry: HistoryEntry, homeDir?: string): void {
  const filePath = historyPath(homeDir);
  ensureDir(path.dirname(filePath));
  const line = JSON.stringify({
    sessionId: entry.sessionId,
    ts: entry.ts,
    text: entry.text,
    ...(entry.model ? { model: entry.model } : {}),
  }) + '\n';
  appendFileSync(filePath, line, 'utf-8');
  maybeTrim(filePath);
}

/** Read back the most recent N turns (useful for resume-picker previews). */
export function readHistory(limit = 100, homeDir?: string): HistoryEntry[] {
  const filePath = historyPath(homeDir);
  if (!existsSync(filePath)) return [];
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    const entries: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      const line = lines[i]!;
      try {
        const obj = JSON.parse(line) as { sessionId?: string; ts?: number; text?: string; model?: string };
        if (obj.sessionId && typeof obj.ts === 'number' && obj.text) {
          entries.push({ sessionId: obj.sessionId, ts: obj.ts, text: obj.text, model: obj.model });
        }
      } catch {
        // skip corrupt lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Trim the oldest lines when the file exceeds MAX_HISTORY_BYTES so the
 * history file stays small without any background cleanup daemon.
 */
function maybeTrim(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.length <= MAX_HISTORY_BYTES) return;
    const lines = content.split('\n').filter(Boolean);
    const target = Math.floor(lines.length * SOFT_CAP_RATIO);
    if (target >= lines.length) return;
    writeFileSync(filePath, lines.slice(-target).join('\n') + '\n', 'utf-8');
  } catch {
    // best-effort — do not break the turn for a history trim failure
  }
}
