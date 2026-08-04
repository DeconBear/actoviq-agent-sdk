import type { HadamardCompactConfig, HadamardCompactState } from '../types.js';
import { resolveHadamardCompactBudget } from '../runtime/hadamardCompact.js';
import type { HadamardMemoryApi, HadamardMemoryBrowserEntry } from './hadamardMemory.js';
import type { MemoryProposalService } from './memoryProposalService.js';

export interface HadamardMemoryCommandResult {
  title: string;
  message: string;
  text?: string;
  items?: Array<{ label: string; description?: string; detail?: string }>;
}

export class HadamardMemoryCommandService {
  constructor(private readonly bindings: {
    memory: HadamardMemoryApi;
    proposals: MemoryProposalService;
    compactConfig: HadamardCompactConfig;
    getState: () => Promise<HadamardCompactState>;
  }) {}

  async execute(input: string): Promise<HadamardMemoryCommandResult> {
    const [action = 'status', ...rest] = input.trim().split(/\s+/u).filter(Boolean);
    if (action === 'status') return this.status();
    if (action === 'list') {
      const kind = normalizeKind(rest[0]);
      const entries = await this.bindings.memory.listMemoryContent(kind ? { kind } : {});
      return {
        title: 'Memory Browser',
        message: `${entries.length} memory item(s).`,
        items: entries.map(entry => formatEntry(entry)),
      };
    }
    if (action === 'show') {
      const idOrPath = rest.join(' ').trim();
      if (!idOrPath) throw new Error('Usage: /memory show <id-or-path>');
      const selected = await this.bindings.memory.readMemoryContent(idOrPath);
      return {
        title: selected.entry.id,
        message: selected.entry.path,
        text: selected.content,
      };
    }
    if (action === 'proposals') {
      const proposals = await this.bindings.proposals.list('pending');
      return {
        title: 'Memory proposals',
        message: `${proposals.length} pending memory proposal(s).`,
        items: proposals.map(proposal => ({
          label: proposal.id,
          description: `${proposal.targetPath} · ${proposal.explanation}`,
          detail: proposal.content,
        })),
      };
    }
    if (action === 'apply' || action === 'reject') {
      const proposalId = rest[0];
      if (!proposalId) throw new Error(`Usage: /memory ${action} <proposal-id>`);
      if (action === 'apply') {
        if (rest[1] !== '--confirm') {
          throw new Error('Preview the proposal, then use /memory apply <proposal-id> --confirm.');
        }
        await this.bindings.proposals.apply(proposalId);
      } else {
        await this.bindings.proposals.reject(proposalId);
      }
      return {
        title: 'Memory proposals',
        message: `Memory proposal ${action === 'apply' ? 'applied' : 'rejected'}: ${proposalId}.`,
      };
    }
    throw new Error(
      'Usage: /memory [status|list [durable|raw]|show <id-or-path>|proposals|apply <id> --confirm|reject <id>]',
    );
  }

  private async status(): Promise<HadamardMemoryCommandResult> {
    const state = await this.bindings.getState();
    const budget = resolveHadamardCompactBudget(this.bindings.compactConfig);
    const current = state.estimatedConversationTokens ?? 0;
    return {
      title: 'Memory',
      message: `Project memory: ${state.paths.projectPath}`,
      text: [
        `Compact raw window: ${budget.rawContextWindowTokens} tokens`,
        `Compact effective window: ${budget.effectiveContextWindowTokens} tokens`,
        `Automatic compact limit: ${budget.autoCompactTokenLimit} tokens (${budget.source})`,
        `Current estimated usage: ${current} tokens`,
        `Durable Memory read: ${state.enabled.autoMemory ? 'on' : 'off'}`,
        `Automatic Dream: ${state.enabled.autoDream ? 'on' : 'off'}`,
        this.bindings.compactConfig.contextWindowWarning,
        ...(this.bindings.compactConfig.deprecationWarnings ?? []),
      ].filter((line): line is string => typeof line === 'string').join('\n'),
    };
  }
}

function normalizeKind(value?: string): HadamardMemoryBrowserEntry['kind'] | undefined {
  return value === 'durable' || value === 'raw' ? value : undefined;
}

function formatEntry(entry: HadamardMemoryBrowserEntry): {
  label: string;
  description: string;
  detail: string;
} {
  return {
    label: entry.id,
    description: `${entry.kind} · ${entry.modifiedAt} · ${entry.size} bytes`,
    detail: entry.path,
  };
}
