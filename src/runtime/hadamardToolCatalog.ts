import type { McpConnectionManager } from '../mcp/connectionManager.js';
import type {
  HadamardCleanToolCatalog,
  HadamardCleanToolCategory,
  HadamardCleanToolLookupOptions,
  HadamardCleanToolMetadata,
  AgentMcpServerDefinition,
  AgentToolDefinition,
  ResolvedToolAdapter,
} from '../types.js';

const FILE_TOOL_NAMES = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep']);

export class HadamardToolsApi {
  constructor(
    private readonly resolveToolMetadata: (
      options?: HadamardCleanToolLookupOptions,
    ) => Promise<HadamardCleanToolMetadata[]>,
  ) {}

  async list(options?: HadamardCleanToolLookupOptions): Promise<string[]> {
    return (await this.listMetadata(options)).map(tool => tool.name);
  }

  async listMetadata(options?: HadamardCleanToolLookupOptions): Promise<HadamardCleanToolMetadata[]> {
    return this.resolveToolMetadata(options);
  }

  async getMetadata(
    name: string,
    options?: HadamardCleanToolLookupOptions,
  ): Promise<HadamardCleanToolMetadata | undefined> {
    return (await this.listMetadata(options)).find(tool => tool.name === name);
  }

  async getCatalog(options?: HadamardCleanToolLookupOptions): Promise<HadamardCleanToolCatalog> {
    const tools = await this.listMetadata(options);
    return buildHadamardCleanToolCatalog(tools);
  }
}

export async function resolveHadamardCleanToolMetadata(params: {
  mcpManager: McpConnectionManager;
  defaultTools: AgentToolDefinition[];
  defaultMcpServers: AgentMcpServerDefinition[];
  lookup?: HadamardCleanToolLookupOptions;
}): Promise<HadamardCleanToolMetadata[]> {
  const adapters = await params.mcpManager.resolveToolAdapters(
    mergeUniqueTools(params.defaultTools, params.lookup?.tools ?? []),
    [...params.defaultMcpServers, ...(params.lookup?.mcpServers ?? [])],
  );

  return adapters.map(summarizeHadamardResolvedTool).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function summarizeHadamardResolvedTool(adapter: ResolvedToolAdapter): HadamardCleanToolMetadata {
  return {
    name: adapter.publicName,
    description: adapter.providerTool.description ?? '',
    provider: adapter.provider,
    category: inferHadamardCleanToolCategory(adapter),
    server: adapter.mcpServerName,
    strict: adapter.providerTool.strict ?? true,
    readOnly: adapter.isReadOnly?.(undefined) ?? false,
    mutating: adapter.isReadOnly !== undefined && adapter.isReadOnly(undefined) === false,
    examples: adapter.providerTool.input_examples,
  };
}

export function buildHadamardCleanToolCatalog(
  tools: readonly HadamardCleanToolMetadata[],
): HadamardCleanToolCatalog {
  const byCategory: HadamardCleanToolCatalog['byCategory'] = {
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

function inferHadamardCleanToolCategory(
  adapter: ResolvedToolAdapter,
): HadamardCleanToolCategory {
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
