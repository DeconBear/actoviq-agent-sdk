import type { McpConnectionManager } from '../mcp/connectionManager.js';
import type {
  ActoviqCleanToolCatalog,
  ActoviqCleanToolCategory,
  ActoviqCleanToolLookupOptions,
  ActoviqCleanToolMetadata,
  AgentMcpServerDefinition,
  AgentToolDefinition,
  ResolvedToolAdapter,
} from '../types.js';
import { isMutatingActoviqTool, isReadOnlyActoviqTool } from './actoviqPermissions.js';

const FILE_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

export class ActoviqToolsApi {
  constructor(
    private readonly resolveToolMetadata: (
      options?: ActoviqCleanToolLookupOptions,
    ) => Promise<ActoviqCleanToolMetadata[]>,
  ) {}

  async list(options?: ActoviqCleanToolLookupOptions): Promise<string[]> {
    return (await this.listMetadata(options)).map(tool => tool.name);
  }

  async listMetadata(options?: ActoviqCleanToolLookupOptions): Promise<ActoviqCleanToolMetadata[]> {
    return this.resolveToolMetadata(options);
  }

  async getMetadata(
    name: string,
    options?: ActoviqCleanToolLookupOptions,
  ): Promise<ActoviqCleanToolMetadata | undefined> {
    return (await this.listMetadata(options)).find(tool => tool.name === name);
  }

  async getCatalog(options?: ActoviqCleanToolLookupOptions): Promise<ActoviqCleanToolCatalog> {
    const tools = await this.listMetadata(options);
    return buildActoviqCleanToolCatalog(tools);
  }
}

export async function resolveActoviqCleanToolMetadata(params: {
  mcpManager: McpConnectionManager;
  defaultTools: AgentToolDefinition[];
  defaultMcpServers: AgentMcpServerDefinition[];
  lookup?: ActoviqCleanToolLookupOptions;
}): Promise<ActoviqCleanToolMetadata[]> {
  const adapters = await params.mcpManager.resolveToolAdapters(
    mergeUniqueTools(params.defaultTools, params.lookup?.tools ?? []),
    [...params.defaultMcpServers, ...(params.lookup?.mcpServers ?? [])],
  );

  return adapters.map(summarizeActoviqResolvedTool).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function summarizeActoviqResolvedTool(adapter: ResolvedToolAdapter): ActoviqCleanToolMetadata {
  return {
    name: adapter.publicName,
    description: adapter.providerTool.description ?? '',
    provider: adapter.provider,
    category: inferActoviqCleanToolCategory(adapter),
    server: adapter.mcpServerName,
    strict: adapter.providerTool.strict ?? true,
    readOnly: isReadOnlyActoviqTool(adapter.publicName),
    mutating: isMutatingActoviqTool(adapter.publicName),
    examples: adapter.providerTool.input_examples,
  };
}

export function buildActoviqCleanToolCatalog(
  tools: readonly ActoviqCleanToolMetadata[],
): ActoviqCleanToolCatalog {
  const byCategory: ActoviqCleanToolCatalog['byCategory'] = {
    file: [],
    task: [],
    computer: [],
    mcp: [],
    custom: [],
  };

  for (const tool of tools) {
    byCategory[tool.category].push(tool);
  }

  return {
    tools: [...tools],
    byCategory,
  };
}

function inferActoviqCleanToolCategory(
  adapter: ResolvedToolAdapter,
): ActoviqCleanToolCategory {
  if (adapter.provider === 'mcp') {
    return 'mcp';
  }

  if (adapter.publicName === 'Task') {
    return 'task';
  }

  if (
    adapter.publicName.startsWith('computer_') ||
    adapter.publicName === 'computer'
  ) {
    return 'computer';
  }

  if (FILE_TOOL_NAMES.has(adapter.publicName)) {
    return 'file';
  }

  return 'custom';
}

function mergeUniqueTools(
  defaults: AgentToolDefinition[],
  additions: AgentToolDefinition[],
): AgentToolDefinition[] {
  const merged = new Map<string, AgentToolDefinition>();
  for (const tool of defaults) {
    merged.set(tool.name, tool);
  }
  for (const tool of additions) {
    merged.set(tool.name, tool);
  }
  return [...merged.values()];
}
