/**
 * Actoviq Core Tools — unified factory for all tools.
 *
 * Provides Read, Write, Edit, Glob, Grep, Bash, TodoWrite, AskUserQuestion,
 * WebFetch, WebSearch, NotebookEdit, and PowerShell by default.
 *
 * The placeholder Task tools (TaskCreate/TaskUpdate/...) and misc tools
 * (Config/ToolSearch/Skill/SendMessage/RemoteTrigger) are opt-in: the SDK
 * client injects real Task, TaskList/TaskGet/TaskStop/TaskOutput, and Skill
 * implementations at runtime, and exposing the no-op stubs alongside them
 * confuses the model and wastes turns.
 *
 * All schemas, descriptions, and prompts match Claude Code exactly.
 */
import type { AgentToolDefinition } from '../types.js';
import { createActoviqFileTools, type ActoviqFileToolsOptions } from './actoviqFileTools.js';
import { createActoviqWebTools } from './actoviqWebTools.js';
import { createTavilySearchTool } from './tavilySearch.js';
import { createBashTool } from './bash/BashTool.js';
import { createTodoWriteTool } from './todo/TodoWriteTool.js';
import { createAskUserQuestionTool } from './askUserQuestion/AskUserQuestionTool.js';
import { createPlanModeTools } from './planMode/PlanModeTools.js';
import { createActoviqTaskTools } from './actoviqTaskTools.js';
import { createNotebookEditTool } from './actoviqNotebookEdit.js';
import { createPowerShellTool } from './actoviqShellTools.js';
import { createActoviqMiscTools } from './actoviqMiscTools.js';

export interface ActoviqCoreToolsOptions extends ActoviqFileToolsOptions {
  bash?: boolean;
  todoWrite?: boolean;
  askUserQuestion?: boolean;
  planModeTools?: boolean;
  webTools?: boolean;
  taskTools?: boolean;
  notebookEdit?: boolean;
  powershell?: boolean;
  miscTools?: boolean;
}

export function createActoviqCoreTools(
  options: ActoviqCoreToolsOptions = {},
): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    ...createActoviqFileTools({ cwd: options.cwd }),
  ];

  if (options.bash !== false) tools.push(createBashTool());
  if (options.todoWrite !== false) tools.push(createTodoWriteTool());
  if (options.askUserQuestion !== false) tools.push(createAskUserQuestionTool());
  // Plan-mode tools let the agent enter/exit planning and present a plan.
  if (options.planModeTools !== false && options.cwd) {
    tools.push(...createPlanModeTools(options.cwd));
  }
  if (options.webTools !== false) {
    tools.push(...createActoviqWebTools());
    // Tavily: enabled when TAVILY_API_KEY is set (no Python dependency)
    if (process.env.TAVILY_API_KEY) tools.push(createTavilySearchTool());
  }
  if (options.taskTools === true) tools.push(...createActoviqTaskTools());
  if (options.notebookEdit !== false) tools.push(createNotebookEditTool());
  if (options.powershell !== false) tools.push(createPowerShellTool());
  if (options.miscTools === true) tools.push(...createActoviqMiscTools());

  return tools;
}
