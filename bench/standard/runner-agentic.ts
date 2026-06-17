#!/usr/bin/env npx tsx
/**
 * Execution-track runner — tests REAL production capability.
 *
 * A full-tool agent (read/write/edit/Bash/...) works in an isolated copy of a
 * fixture project, then an objective verifier command is run in that workspace
 * (exit 0 = pass). No LLM judge for the outcome — the work either passes the
 * verifier or it doesn't. The workspace is a temp dir, so writes/commands are
 * safe and never touch the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentSdk, loadDefaultActoviqSettings, createActoviqCoreTools, createTeamTool } from '../../src/index.js';
import type { AgentConfig, BenchmarkTask, RunMetrics, ToolCallRecord } from './types.js';
import { buildAgenticPrompt } from './prompt.js';
import { TEAM_DEF } from './runner-hadamard.js';

const execAsync = promisify(exec);

/** Snapshot relative file path -> "size:mtime" for change detection (skips node_modules/.git). */
function snapshotFiles(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else {
        const st = fs.statSync(full);
        map.set(r, `${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    }
  };
  walk(dir, '');
  return map;
}

export async function runAgenticAgent(
  task: BenchmarkTask,
  agent: AgentConfig,
): Promise<{ answer: string; metrics: RunMetrics }> {
  await loadDefaultActoviqSettings().catch(() => {});

  const fixtureDir = path.join(process.cwd(), 'bench', 'fixtures', 'agentic', task.fixture ?? '');
  if (!task.fixture || !fs.existsSync(fixtureDir)) {
    throw new Error(`Fixture not found for ${task.id}: ${fixtureDir}`);
  }

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'actoviq-bench-'));
  const start = Date.now();
  try {
    fs.cpSync(fixtureDir, ws, { recursive: true });
    const before = snapshotFiles(ws);

    const tools = createActoviqCoreTools({ cwd: ws });
    if (agent.hasTeamTool) tools.push(createTeamTool(TEAM_DEF));

    const sdk = await createAgentSdk({ workDir: ws, tools, permissionMode: 'bypassPermissions' });
    const session = await sdk.createSession({ title: `bench-${task.id}` });
    const prompt =
      `Your working directory is: ${ws}\n` +
      `All project files (e.g. src/, test/) are inside that directory — use it as the base for every file path and shell command.\n\n` +
      buildAgenticPrompt(task, { hasTeamTool: agent.hasTeamTool });
    const result = await session.send(prompt, { permissionMode: 'bypassPermissions' });
    const totalIn = result.requests.reduce((s: number, r: any) => s + (r.usage?.input_tokens ?? 0), 0);
    const totalOut = result.requests.reduce((s: number, r: any) => s + (r.usage?.output_tokens ?? 0), 0);
    await sdk.close();

    const after = snapshotFiles(ws);
    const filesChanged = [...after.entries()]
      .filter(([rel, sig]) => before.get(rel) !== sig)
      .map(([rel]) => rel)
      .sort();

    // Objective verification in the workspace.
    let verified = false;
    let verifyOutput = '';
    try {
      const { stdout, stderr } = await execAsync(task.verify ?? 'true', { cwd: ws, timeout: 120_000, encoding: 'utf-8' });
      verified = true;
      verifyOutput = `${stdout}\n${stderr}`.trim().slice(0, 2000);
    } catch (e: any) {
      verified = false;
      verifyOutput = `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`.trim().slice(0, 2000);
    }

    const toolCalls: ToolCallRecord[] = result.toolCalls.map((tc: any) => ({
      name: tc.name,
      durationMs: tc.durationMs ?? 0,
      isError: tc.isError ?? false,
      inputSummary: typeof tc.input === 'string' ? tc.input.slice(0, 100) : JSON.stringify(tc.input ?? {}).slice(0, 100),
    }));

    return {
      answer: result.text,
      metrics: {
        durationMs: Date.now() - start,
        toolCallCount: result.toolCalls.length,
        toolCalls,
        inputTokens: totalIn,
        outputTokens: totalOut,
        iterationCount: result.requests.length,
        answerLength: result.text.length,
        estimatedCost: 0,
        verified,
        verifyOutput,
        filesChanged,
      },
    };
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
