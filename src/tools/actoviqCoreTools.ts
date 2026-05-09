import type { AgentToolDefinition } from '../types.js';
import { createActoviqFileTools, type ActoviqFileToolsOptions } from './actoviqFileTools.js';
import { createActoviqWebTools } from './actoviqWebTools.js';
import { createBashTool } from './bash/BashTool.js';
import { createTodoWriteTool } from './todo/TodoWriteTool.js';
import { createAskUserQuestionTool } from './askUserQuestion/AskUserQuestionTool.js';

export interface ActoviqCoreToolsOptions extends ActoviqFileToolsOptions {
  /** Include Bash tool. Default: true */
  bash?: boolean;
  /** Include TodoWrite tool. Default: true */
  todoWrite?: boolean;
  /** Include AskUserQuestion tool. Default: true */
  askUserQuestion?: boolean;
  /** Include Web tools (WebFetch, WebSearch). Default: true */
  webTools?: boolean;
}

/**
 * Creates the full set of core Actoviq tools, aligned with Claude Code's
 * tool naming conventions, schemas, descriptions, and prompts.
 */
export function createActoviqCoreTools(
  options: ActoviqCoreToolsOptions = {},
): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    ...createActoviqFileTools({ cwd: options.cwd }),
  ];

  if (options.bash !== false) {
    tools.push(createBashTool());
  }
  if (options.todoWrite !== false) {
    tools.push(createTodoWriteTool());
  }
  if (options.askUserQuestion !== false) {
    tools.push(createAskUserQuestionTool());
  }
  if (options.webTools !== false) {
    tools.push(...createActoviqWebTools());
  }

  return tools;
}
