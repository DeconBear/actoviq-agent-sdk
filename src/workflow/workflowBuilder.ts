import type { ActoviqAgentClient } from '../runtime/agentClient.js';
import { WorkflowEngine } from './workflowEngine.js';
import type {
  WorkflowDefinition,
  WorkflowParameter,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowStepDefinition,
} from './types.js';

interface StepOptions {
  dependsOn?: string[];
  allowedTools?: string[];
  tools?: (string | import('../types.js').AgentToolDefinition)[];
  mcpServers?: WorkflowStepDefinition['mcpServers'];
  skillDirectories?: string[];
  model?: string | null;
  systemPrompt?: string;
  /** 'react' (default) = full tool-using loop; 'single' = one-shot answer, no tools. */
  mode?: 'react' | 'single';
}

export class WorkflowBuilder {
  private steps: WorkflowStepDefinition[] = [];
  private params: Record<string, WorkflowParameter> = {};
  private globalModel?: string | null;
  private globalSystemPrompt?: string;

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly name: string,
    private readonly description: string,
    private readonly workDir: string,
  ) {}

  param(name: string, def: WorkflowParameter): this {
    this.params[name] = def;
    return this;
  }

  model(model: string | null): this {
    this.globalModel = model;
    return this;
  }

  systemPrompt(prompt: string): this {
    this.globalSystemPrompt = prompt;
    return this;
  }

  step(id: string, description: string, prompt: string, opts?: StepOptions): this {
    this.steps.push({
      id,
      description,
      prompt,
      tools: opts?.tools,
      mcpServers: opts?.mcpServers,
      allowedTools: opts?.allowedTools,
      skillDirectories: opts?.skillDirectories,
      model: opts?.model,
      systemPrompt: opts?.systemPrompt,
      mode: opts?.mode,
      dependsOn: opts?.dependsOn ?? [],
    });
    return this;
  }

  async run(
    params: Record<string, unknown> = {},
    options?: Partial<WorkflowRunOptions>,
  ): Promise<WorkflowRunResult> {
    const definition: WorkflowDefinition = {
      name: this.name,
      description: this.description,
      steps: this.steps,
      parameters: Object.keys(this.params).length > 0 ? this.params : undefined,
      model: this.globalModel,
      systemPrompt: this.globalSystemPrompt,
    };
    return this.engine.run(definition, params, {
      workDir: this.workDir,
      ...options,
    });
  }
}

export class WorkflowApi {
  private readonly engine: WorkflowEngine;
  private readonly workDir: string;

  constructor(sdk: ActoviqAgentClient) {
    this.engine = new WorkflowEngine(sdk);
    this.workDir = sdk.config.workDir;
  }

  define(name: string, description = ''): WorkflowBuilder {
    return new WorkflowBuilder(this.engine, name, description, this.workDir);
  }

  async run(
    definition: WorkflowDefinition,
    params: Record<string, unknown> = {},
    options?: Partial<WorkflowRunOptions>,
  ): Promise<WorkflowRunResult> {
    return this.engine.run(definition, params, {
      workDir: this.workDir,
      ...options,
    });
  }
}
