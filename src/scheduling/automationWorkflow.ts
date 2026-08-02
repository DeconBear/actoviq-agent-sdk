import type { ScheduledAutomationTask, TeamDefinition } from '../types.js';
import { loadTeamDefinition } from '../team/teamDefinitions.js';
import { validateWorkflowSquad } from '../team/workflowSquad.js';
import { loadWorkflow, type SavedWorkflow } from '../workflow/workflowPersistence.js';

export type ScheduledAutomationWorkflowTarget =
  | { source: 'agent'; definition: TeamDefinition }
  | { source: 'script'; workflow: SavedWorkflow };

export function resolveScheduledAutomationWorkflow(
  task: Pick<ScheduledAutomationTask, 'workflowName' | 'workflowSource'>,
  workDir: string,
  homeDir?: string,
): ScheduledAutomationWorkflowTarget {
  const name = task.workflowName?.trim();
  if (!name) throw new Error('Scheduled workflow task is missing workflowName');

  if (task.workflowSource === 'agent') {
    const loaded = loadTeamDefinition(name, workDir, homeDir);
    if (!loaded) throw new Error(`Agent workflow not found: ${name}`);
    if (loaded.definition.squadType !== 'workflow') {
      throw new Error(`Configured Agent definition "${name}" is not an Agent workflow`);
    }
    const problems = validateWorkflowSquad(loaded.definition);
    if (problems.length) throw new Error(`Invalid Agent workflow "${name}": ${problems.join('; ')}`);
    return { source: 'agent', definition: loaded.definition };
  }

  const workflow = loadWorkflow(name, workDir, homeDir);
  if (!workflow) throw new Error(`Legacy workflow script not found: ${name}`);
  return { source: 'script', workflow };
}
