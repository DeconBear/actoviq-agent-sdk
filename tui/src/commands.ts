import type { SlashCommand } from './types.js';

// ── Command registry ────────────────────────────────────────────

export interface SlashCommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: (args: string) => Promise<string> | string;
}

export function createCommandRegistry() {
  const commands = new Map<string, SlashCommandDef>();

  function register(cmd: SlashCommandDef): void {
    commands.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        commands.set(alias, cmd);
      }
    }
  }

  function get(name: string): SlashCommandDef | undefined {
    return commands.get(name);
  }

  function list(): SlashCommandDef[] {
    // Deduplicate by name
    const seen = new Set<string>();
    const result: SlashCommandDef[] = [];
    for (const cmd of commands.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  function match(input: string): SlashCommandDef | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;
    const spaceIdx = trimmed.indexOf(' ');
    const cmdName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    return commands.get(cmdName) ?? null;
  }

  return { register, get, list, match };
}

// ── Built-in commands ───────────────────────────────────────────

export function registerBuiltinCommands(
  registry: ReturnType<typeof createCommandRegistry>,
  context: CommandContext,
): void {
  registry.register({
    name: 'help',
    description: 'Show available commands',
    handler: () => {
      const cmds = registry.list();
      const lines = cmds.map((c) => `  /${c.name.padEnd(14)} ${c.description}`);
      return `Available commands:\n\n${lines.join('\n')}`;
    },
  });

  registry.register({
    name: 'clear',
    description: 'Clear the screen',
    handler: () => {
      context.onClear();
      return '';
    },
  });

  registry.register({
    name: 'memory',
    description: 'Show memory/compact state',
    handler: async () => {
      try {
        const state = await context.getCompactState();
        return `Memory state:\n  Compact count: ${state?.compactCount ?? 'N/A'}\n  Compaction threshold: N/A`;
      } catch {
        return 'Unable to fetch memory state.';
      }
    },
  });

  registry.register({
    name: 'compact',
    aliases: ['compress'],
    description: 'Compact the current session',
    usage: '/compact [force]',
    handler: async (args) => {
      try {
        const result = await context.compact(args.includes('force'));
        return `Compaction complete. ${result?.summarizedCount ?? 0} messages summarized.`;
      } catch (e) {
        return `Compaction failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  registry.register({
    name: 'dream',
    description: 'Trigger memory consolidation',
    usage: '/dream [force]',
    handler: async (args) => {
      try {
        const result = await context.dream(args.includes('force'));
        return `Dream consolidation complete.`;
      } catch (e) {
        return `Dream failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  registry.register({
    name: 'tools',
    description: 'List available tools',
    handler: async () => {
      const tools = await context.getTools();
      if (!tools || tools.length === 0) return 'No tools available.';
      const lines = tools.map((t) => `  ${t.name.padEnd(24)} ${t.description ?? ''}`);
      return `Available tools (${tools.length}):\n\n${lines.join('\n')}`;
    },
  });

  registry.register({
    name: 'skills',
    description: 'List available skills',
    handler: () => {
      const skills = context.getSkills();
      if (!skills || skills.length === 0) return 'No skills available.';
      const lines = skills.map((s) => `  ${s.name.padEnd(24)} ${s.description ?? ''}`);
      return `Available skills (${skills.length}):\n\n${lines.join('\n')}`;
    },
  });

  registry.register({
    name: 'agents',
    description: 'List registered agents',
    handler: () => {
      const agents = context.getAgents();
      if (!agents || agents.length === 0) return 'No agents registered.';
      const lines = agents.map((a) => `  ${a.name.padEnd(24)} ${a.description ?? ''}`);
      return `Registered agents (${agents.length}):\n\n${lines.join('\n')}`;
    },
  });

  registry.register({
    name: 'session',
    aliases: ['sessions'],
    description: 'Session management',
    usage: '/session [new|switch|delete|list]',
    handler: async (args) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      if (!sub || sub === 'list') {
        const sessions = context.getSessions();
        if (sessions.length === 0) return 'No sessions.';
        const lines = sessions.map((s) => `  ${s.id === context.currentSessionId ? '* ' : '  '}${s.id.slice(0, 8)}  ${s.title ?? 'Untitled'}`);
        return `Sessions:\n\n${lines.join('\n')}`;
      }
      if (sub === 'new') {
        await context.createSession({ title: parts.slice(1).join(' ') || undefined });
        return 'New session created and activated.';
      }
      if (sub === 'switch' && parts[1]) {
        await context.switchSession(parts[1]);
        return `Switched to session ${parts[1]}.`;
      }
      if (sub === 'delete' && parts[1]) {
        await context.deleteSession(parts[1]);
        return `Session ${parts[1]} deleted.`;
      }
      return 'Usage: /session [new|switch <id>|delete <id>|list]';
    },
  });

  registry.register({
    name: 'scheduler',
    description: 'Show scheduled tasks',
    handler: async () => {
      const tasks = await context.getScheduledTasks();
      if (!tasks || tasks.length === 0) return 'No scheduled tasks.';
      const lines = tasks.map((t) => `  ${t.id.padEnd(20)} ${t.schedule.padEnd(16)} next: ${t.nextRunAt ?? 'N/A'}`);
      return `Scheduled tasks (${tasks.length}):\n\n${lines.join('\n')}`;
    },
  });

  registry.register({
    name: 'checkpoint',
    description: 'Checkpoint management',
    usage: '/checkpoint [save|list|restore <id>]',
    handler: async (args) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      try {
        if (sub === 'save') {
          const cp = await context.saveCheckpoint(parts.slice(1).join(' ') || 'manual');
          return `Checkpoint saved: ${cp.id}`;
        }
        if (sub === 'list') {
          const cps = await context.listCheckpoints();
          if (cps.length === 0) return 'No checkpoints.';
          const lines = cps.map((c) => `  ${c.id.slice(0, 8)}  ${c.label ?? ''}`);
          return `Checkpoints:\n\n${lines.join('\n')}`;
        }
        if (sub === 'restore' && parts[1]) {
          await context.restoreCheckpoint(parts[1]);
          context.onClear();
          return `Restored checkpoint ${parts[1]}.`;
        }
      } catch (e) {
        return `Checkpoint operation failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      return 'Usage: /checkpoint [save <label>|list|restore <id>]';
    },
  });

  registry.register({
    name: 'swarm',
    description: 'Multi-agent swarm ops',
    usage: '/swarm [spawn|list|inbox|message]',
    handler: async () => {
      return 'Swarm management available in the Swarm panel.';
    },
  });

  registry.register({
    name: 'model',
    description: 'Show or change the model',
    usage: '/model [list|<name>]',
    handler: async (args) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      if (!sub || sub === 'show') {
        const current = context.getModel();
        return `Current model: ${current}`;
      }
      if (sub === 'list') {
        const models = context.listModels();
        if (models.length === 0) return 'No models configured.';
        const current = context.getModel();
        const lines = models.map((m) => (m === current ? `  * ${m}` : `    ${m}`));
        return `Available models:\n${lines.join('\n')}`;
      }
      // Treat as a model name
      const models = context.listModels();
      if (!models.includes(sub)) {
        return `Unknown model "${sub}". Use /model list to see available models.`;
      }
      const ok = await context.setModel(sub);
      if (ok) return `Model changed to ${sub}.`;
      return `Failed to set model "${sub}".`;
    },
  });

  registry.register({
    name: 'buddy',
    description: 'Show companion status',
    handler: () => {
      return context.getBuddyStatus?.() ?? 'Buddy is not configured.';
    },
  });
}

// ── Command context interface ───────────────────────────────────

export interface CommandContext {
  currentSessionId: string | null;
  onClear: () => void;
  getCompactState: () => Promise<{ compactCount?: number } | null>;
  compact: (force?: boolean) => Promise<{ summarizedCount?: number } | null>;
  dream: (force?: boolean) => Promise<void>;
  getTools: () => Promise<Array<{ name: string; description?: string }>>;
  getSkills: () => Array<{ name: string; description?: string }>;
  getAgents: () => Array<{ name: string; description?: string }>;
  getSessions: () => Array<{ id: string; title?: string }>;
  createSession: (options?: { title?: string }) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  getScheduledTasks: () => Promise<Array<{ id: string; schedule: string; nextRunAt?: string }>>;
  saveCheckpoint: (label: string) => Promise<{ id: string }>;
  listCheckpoints: () => Promise<Array<{ id: string; label?: string }>>;
  restoreCheckpoint: (id: string) => Promise<void>;
  getModel: () => string;
  setModel: (model: string) => Promise<boolean>;
  listModels: () => string[];
  getBuddyStatus?: () => string;
}
