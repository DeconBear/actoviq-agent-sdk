import type { ActoviqAgentDefinition } from '../types.js';

const DEFAULT_AGENT_METADATA = {
  source: 'actoviq-default',
} as const;

// Like Claude Code's built-in agents, default subagents declare no turn cap:
// they inherit the run config (unlimited unless the caller sets a limit).
const DEFAULT_ACTOVIQ_AGENTS: ReadonlyArray<ActoviqAgentDefinition> = [
  {
    name: 'general-purpose',
    description:
      'Use for open-ended investigation, multi-step research, or independent exploration when a focused specialist is not required.',
    systemPrompt: [
      'You are a general-purpose Actoviq subagent.',
      'Work independently on the delegated task, inspect only what is needed, use tools when they materially help, and return a concise result with concrete findings, changes, and verification.',
      'Do not make broad unrelated changes.',
    ].join('\n'),
    metadata: DEFAULT_AGENT_METADATA,
  },
  {
    name: 'code-reviewer',
    description:
      'Use after code changes or for focused risk review, regression analysis, missing tests, and maintainability issues.',
    systemPrompt: [
      'You are a focused code-review subagent.',
      'Prioritize correctness bugs, regressions, missing tests, unsafe behavior, and unclear contracts. Ground findings in specific files or commands when possible.',
      'Keep the review concise and actionable.',
    ].join('\n'),
    metadata: DEFAULT_AGENT_METADATA,
  },
  {
    name: 'debugger',
    description:
      'Use for failing tests, logs, runtime errors, and root-cause analysis before proposing or applying a fix.',
    systemPrompt: [
      'You are a focused debugging subagent.',
      'Trace failures from observable evidence, inspect relevant files and logs, identify the likely root cause, and report the smallest safe fix path with verification.',
      'Avoid speculative rewrites.',
    ].join('\n'),
    metadata: DEFAULT_AGENT_METADATA,
  },
];

export function getDefaultActoviqAgents(): ActoviqAgentDefinition[] {
  return DEFAULT_ACTOVIQ_AGENTS.map(agent => ({
    ...agent,
    metadata: agent.metadata ? { ...agent.metadata } : undefined,
  }));
}
