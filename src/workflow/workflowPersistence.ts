/**
 * Workflow persistence — save/load workflow scripts to/from disk.
 *
 * Search path (project overrides personal):
 *   1. .actoviq/workflows/<name>.js   (project)
 *   2. ~/.actoviq/workflows/<name>.js (personal)
 */
import fs from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resolveActoviqHome } from '../config/actoviqHome.js';
import type { WorkflowMeta } from '../types.js';

export interface SavedWorkflow {
  name: string;
  description: string;
  script: string;
  source: 'project' | 'personal';
  filePath: string;
  meta?: WorkflowMeta;
}

/**
 * Resolve the search paths for workflow scripts.
 */
function resolveWorkflowDirs(projectDir?: string, homeDir?: string): string[] {
  const dirs: string[] = [];
  const home = resolveActoviqHome(homeDir);

  if (projectDir) {
    dirs.push(path.join(projectDir, '.actoviq', 'workflows'));
  }
  dirs.push(path.join(home, 'workflows'));
  return dirs;
}

/**
 * Load a workflow script by name. Project workflows override personal ones.
 */
export function loadWorkflow(
  name: string,
  projectDir?: string,
  homeDir?: string,
): SavedWorkflow | null {
  const dirs = resolveWorkflowDirs(projectDir, homeDir);

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const filePath = path.join(dir, `${name}.js`);
    if (fs.existsSync(filePath)) {
      const script = fs.readFileSync(filePath, 'utf-8');
      const meta = extractWorkflowMeta(script);
      return {
        name,
        description: meta?.description ?? script.slice(0, 100),
        script,
        source: i === 0 && projectDir ? 'project' : 'personal',
        filePath,
        meta,
      };
    }
  }

  return null;
}

/**
 * Save a workflow script to disk.
 */
export async function saveWorkflow(
  name: string,
  script: string,
  options: { projectDir?: string; homeDir?: string; overwrite?: boolean } = {},
): Promise<string> {
  const dirs = resolveWorkflowDirs(options.projectDir, options.homeDir);
  // Save to project dir if available, otherwise personal
  const targetDir = dirs[0]!;
  await mkdir(targetDir, { recursive: true });

  const filePath = path.join(targetDir, `${name}.js`);

  if (fs.existsSync(filePath) && !options.overwrite) {
    throw new Error(`Workflow "${name}" already exists at ${filePath}. Use overwrite: true to replace.`);
  }

  fs.writeFileSync(filePath, script, 'utf-8');
  return filePath;
}

/**
 * List all saved workflows from all search paths.
 */
export function listWorkflows(
  projectDir?: string,
  homeDir?: string,
): SavedWorkflow[] {
  const dirs = resolveWorkflowDirs(projectDir, homeDir);
  const seen = new Set<string>();
  const workflows: SavedWorkflow[] = [];

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const name = entry.name.slice(0, -3);
        if (seen.has(name)) continue; // project overrides personal
        seen.add(name);

        const filePath = path.join(dir, entry.name);
        const script = fs.readFileSync(filePath, 'utf-8');
        const meta = extractWorkflowMeta(script);
        workflows.push({
          name,
          description: meta?.description ?? `Workflow: ${name}`,
          script,
          source: i === 0 && projectDir ? 'project' : 'personal',
          filePath,
          meta,
        });
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return workflows;
}

/**
 * Delete a saved workflow.
 */
export async function deleteWorkflow(
  name: string,
  projectDir?: string,
  homeDir?: string,
): Promise<boolean> {
  const dirs = resolveWorkflowDirs(projectDir, homeDir);

  for (const dir of dirs) {
    const filePath = path.join(dir, `${name}.js`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }

  return false;
}

/**
 * Check if dynamic workflows are disabled.
 */
export function isWorkflowsDisabled(): boolean {
  if (process.env.ACTOVIQ_DISABLE_WORKFLOWS === '1') return true;
  if (process.env.ACTOVIQ_DISABLE_WORKFLOWS === 'true') return true;
  return false;
}

/**
 * Extract meta from a saved script without executing it.
 */
function extractWorkflowMeta(script: string): WorkflowMeta | undefined {
  const match = script.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return undefined;

  try {
    const metaBlock = match[1]!;
    // Safe eval — just a JSON-like object literal
    const fn = new Function(`return ${metaBlock}`);
    const meta = fn() as WorkflowMeta;
    if (meta.name && meta.description) return meta;
  } catch {
    // Ignore parse errors
  }

  return undefined;
}
