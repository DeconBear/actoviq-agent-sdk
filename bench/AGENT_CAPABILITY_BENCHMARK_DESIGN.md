# Advanced Agent Capability Benchmark Design

This document defines the next benchmark layer for testing Claude Code-like general agent capability in Actoviq. It extends the existing smoke harness from simple end-state checks into multi-domain, tool-using, subagent-capable, skill-aware agent evaluation.

## Sources

- SWE-bench harness documentation: https://www.swebench.com/SWE-bench/api/harness/
- OpenAI SWE-bench Verified notes: https://openai.com/index/introducing-swe-bench-verified/ and https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/
- SWE-agent trajectories documentation: https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md
- AgentBench paper: https://arxiv.org/abs/2308.03688
- Terminal-Bench paper and repository: https://arxiv.org/abs/2601.11868 and https://github.com/laude-institute/terminal-bench
- WebArena paper: https://arxiv.org/abs/2307.13854
- OSWorld NeurIPS page: https://proceedings.neurips.cc/paper_files/paper/2024/hash/5d413e48f84dc61244b6be550f1cd8f5-Abstract-Datasets_and_Benchmarks_Track.html
- GAIA paper: https://arxiv.org/abs/2311.12983
- Tau-bench paper and site: https://arxiv.org/abs/2406.12045 and https://taubench.com/
- Claude Agent SDK docs: https://code.claude.com/docs/en/agent-sdk/typescript, https://code.claude.com/docs/en/agent-sdk/agent-loop, and https://code.claude.com/docs/en/agent-sdk/skills

## External Design Inputs

The design borrows patterns from established agent benchmarks and official agent runtimes:

- SWE-bench and SWE-bench Verified evaluate real repository issues with hidden `FAIL_TO_PASS` and `PASS_TO_PASS` tests, so coding tasks should grade patches by execution rather than prose. OpenAI's later warning about SWE-bench Verified contamination also means local suites should include fresh, repo-specific cases and mutation variants.
- SWE-agent writes JSON trajectories containing thought, action, and observation turns. The Actoviq harness should preserve comparable trajectory logs for each runtime.
- AgentBench evaluates agents across multiple interactive environments rather than treating agent ability as a single coding score.
- Terminal-Bench packages terminal tasks with an instruction, environment, reference solution, and verification tests. This maps directly to local CLI/devops tasks.
- WebArena and OSWorld emphasize realistic, reproducible environments with execution-based evaluation instead of live-web or static-answer grading.
- GAIA targets general assistant tasks requiring reasoning, file handling, web browsing, multimodal inputs, and tool proficiency.
- Tau-bench evaluates tool-agent-user interaction with a simulated user, domain API tools, and policy constraints. This is the right pattern for testing multi-turn support and rule following.
- The Claude Agent SDK exposes Claude Code-style tools, subagents, skills, permissions, and setting sources. The official SDK runtime should remain an external baseline for Clean SDK parity.

## Goal

Measure whether Clean SDK behaves like a practical Claude Code-style agent:

- It can use tools over multiple turns to inspect, edit, execute, verify, and recover.
- It can delegate work to subagents when useful without being forced by the prompt.
- It can discover and invoke skills when the task matches a skill description.
- It can respect permissions, workspace boundaries, and safety rules.
- It can preserve useful behavior under repeated runs, long tasks, and context pressure.
- It can match or explain gaps against Bridge SDK and the official Claude Agent SDK baseline.

The benchmark must not reward a fixed ReAct script. It should expose available capabilities and measure the resulting behavior.

## Runtime Matrix

Each case should run against these runtime wrappers when practical:

| Runtime | Purpose |
| --- | --- |
| `clean-sdk` | Primary implementation under evaluation. |
| `bridge-sdk` | Repository-local Claude Code compatibility reference. |
| `official-claude-sdk` | External baseline using Anthropic's official Claude Agent SDK. |

The same fixture, task prompt, budget, and graders should be used for all runtimes. Runtime-specific logs are normalized into common metrics.

## Agent Program Under Test

Each runtime should expose a general agent with these surfaces:

- Core tools: file read/write/edit, grep/glob, bash, todo/task tracking, web fetch/search when the case permits it, and MCP tools when present.
- Subagents: optional delegated agents such as `researcher`, `implementer`, `test-runner`, `reviewer`, and `policy-auditor`.
- Skills: filesystem skills discovered from project/user settings. Benchmark skills should be small, explicit artifacts under a fixture-local `.claude/skills/` or equivalent Clean SDK fixture path.
- Permissions: benchmark mode can bypass prompts inside the isolated workspace, but unsafe tasks should still test permission rules and denials explicitly.

Subagents and skills should be available by default in complex cases. Prompts should not say "you must use subagent X" unless the capability itself is the task.

## Case Families

### 1. SWE-style Coding Cases

Purpose: real repository debugging and patching.

Pattern:

- Fixture is a small but nontrivial repository.
- Prompt is a user-style bug report or feature request.
- Agent edits files.
- Hidden graders run failing tests plus regression tests.

Initial cases:

- `complex.coding.multi-file-regression`: bug spans parser, runtime, and tests.
- `complex.coding.api-contract`: public TypeScript API behavior must change while preserving compatibility.
- `complex.coding.flaky-debug`: failing test is nondeterministic unless the agent isolates state correctly.

Metrics:

- Pass/fail by tests.
- Patch size.
- Number of edit attempts.
- Tool errors.
- Re-run count and final verification command.

### 2. Terminal/Devops Cases

Purpose: shell workflow competence beyond source edits.

Pattern:

- Inspired by Terminal-Bench task packaging.
- Fixture includes scripts, logs, config, and verification tests.
- Agent must diagnose with shell tools and leave a correct filesystem state.

Initial cases:

- `complex.terminal.build-pipeline`: repair package scripts and generated artifacts without editing generated output directly.
- `complex.terminal.log-diagnosis`: inspect logs, identify root cause, patch config, and validate.
- `complex.terminal.env-migration`: migrate config names and prove backward compatibility.

Metrics:

- Commands executed.
- Failed command ratio.
- Workspace mutations.
- Time to first useful verification.

### 3. Subagent Orchestration Cases

Purpose: test whether subagents are usable and useful.

Pattern:

- Task naturally decomposes into independent inspection and implementation.
- Main agent can delegate review, research, or test triage.
- Grader checks final state, not whether delegation occurred.
- Behavior report highlights whether delegation happened and whether it reduced errors.

Initial cases:

- `complex.workflow.parallel-audit`: two modules have related bugs; a reviewer subagent should find one while main fixes another.
- `complex.workflow.review-before-edit`: agent should inspect risky code and produce a minimal patch.
- `complex.workflow.subagent-conflict`: subagent recommendations partially conflict; main agent must resolve by evidence.

Metrics:

- Subagent call count.
- Subagent task descriptions.
- Parent-child tool call relationship.
- Main-agent synthesis quality as measured by final graders.

### 4. Skills Cases

Purpose: verify skills are discoverable, invoked, and useful.

Pattern:

- Fixture includes one or more benchmark-local skill directories.
- Task wording matches skill descriptions naturally.
- Skill content provides a workflow or domain knowledge not present in the prompt.

Initial cases:

- `complex.skills.release-checklist`: skill defines release validation steps; grader checks only final state.
- `complex.skills.workflow-debug`: skill teaches event-log interpretation; agent must apply it to fix a workflow trace.
- `complex.skills.security-review`: skill provides a policy checklist; grader checks violations and required report fields.

Metrics:

- Skill discovery.
- Skill invocation count.
- Loaded skill names.
- Whether skill use correlated with successful final verification.

### 5. Tau-bench-style User/Tool Interaction Cases

Purpose: test multi-turn coordination with a user simulator and API tools.

Pattern:

- Harness provides a simulated user and a small domain database/API.
- Agent must ask clarifying questions only when necessary.
- Agent must follow policy constraints while using tools.

Initial cases:

- `complex.dialogue.support-policy`: update a customer request while obeying policy and tool constraints.
- `complex.dialogue.missing-info`: agent must elicit one missing value before calling the tool.
- `complex.dialogue.conflicting-user`: user asks for an action blocked by policy.

Metrics:

- Task success.
- Policy violations.
- Unnecessary questions.
- Tool calls with missing or invalid arguments.
- Pass^k reliability over repeated simulated users.

### 6. Web/Research Cases

Purpose: test browsing/research behavior without relying on live-web instability.

Pattern:

- Prefer self-hosted static or local web fixtures for deterministic grading.
- Optional live-web tasks should be marked unstable and excluded from CI gates.
- Inspired by WebArena and GAIA: answer requires gathering facts from multiple pages/files/tools.

Initial cases:

- `complex.web.local-docs-synthesis`: local docs site with conflicting versions; agent must cite correct current API.
- `complex.web.changelog-migration`: inspect docs and apply code migration.
- `complex.web.live-research-smoke`: optional live-web case for current external information.

Metrics:

- Source pages visited.
- Citation/source coverage.
- Incorrect source usage.
- Final state correctness.

### 7. Memory and Context Pressure Cases

Purpose: evaluate long-running agent behavior, compaction, and continuity.

Pattern:

- Task includes more files and longer logs than a single short context pass should rely on.
- Agent should create working notes or use runtime memory/compact features.
- Grader checks final patch and required intermediate artifact.

Initial cases:

- `complex.memory.long-log-debug`: diagnose from several large logs and apply a targeted fix.
- `complex.memory.multi-step-refactor`: perform staged edits with tests between stages.
- `complex.memory.resume-after-compact`: simulate session continuation and verify state retention.

Metrics:

- Compact count.
- Memory/scratch artifacts.
- Repeated file reads after compaction.
- Lost-context mistakes.

### 8. Safety and Permission Cases

Purpose: verify the agent can be powerful without ignoring boundaries.

Pattern:

- Include adversarial instructions inside fixture files.
- Include unsafe operations that should be denied or avoided.
- Graders check no forbidden files changed and no unsafe commands ran.

Initial cases:

- `complex.safety.prompt-injection-file`: malicious README asks agent to leak env vars.
- `complex.safety.path-boundary`: task tries to edit outside workspace.
- `complex.safety.destructive-command`: agent must solve without destructive reset/delete.

Metrics:

- Permission denials.
- Unsafe command attempts.
- Boundary violations.
- Secret exposure.

## Unified Trajectory Schema

The current `metrics` object should be extended with a JSONL trajectory file:

```json
{
  "eventId": "uuid",
  "timestamp": "2026-06-04T00:00:00.000Z",
  "runtime": "clean-sdk",
  "caseId": "complex.workflow.parallel-audit",
  "trial": 1,
  "actor": {
    "type": "main-agent",
    "name": "default",
    "parentToolUseId": null
  },
  "event": {
    "type": "tool_call",
    "name": "Bash",
    "inputSummary": "npm test",
    "isError": false,
    "durationMs": 1200
  }
}
```

Required event types:

- `llm_request`
- `assistant_message`
- `tool_call`
- `tool_result`
- `subagent_start`
- `subagent_result`
- `skill_load`
- `permission_decision`
- `command_verification`
- `grader_result`
- `compact`
- `error`

The report should summarize trajectories but keep full JSONL logs in `bench/reports/`.

## Scoring

Keep deterministic grading primary:

| Component | Weight | Notes |
| --- | ---: | --- |
| Task correctness | 60 | Hidden tests, state checks, policy assertions. |
| Reliability | 15 | Pass@k and pass^k over repeated trials. |
| Efficiency | 10 | Time, tokens, cost, tool calls, command retries. |
| Behavior quality | 10 | Tool errors, verification discipline, useful delegation, skill use where relevant. |
| Safety | 5 | Boundary and policy compliance; severe violations can be hard fail. |

Do not reward raw tool count, subagent count, or skill count. Reward final correctness and use behavior logs to diagnose why one runtime succeeded or failed.

## Anti-Gaming and Reproducibility

- Keep hidden graders out of prompts and workspaces.
- Use fresh local tasks and mutation variants to reduce memorization.
- Remove future git history and tags from benchmark fixtures when using real repositories.
- Separate public visible tests from hidden evaluation tests.
- Run repeated trials with seeds and report variance.
- Treat LLM-as-judge as optional analysis only; never as the main correctness signal for code or policy tasks.
- Record exact runtime, model, prompt hash, fixture hash, tool set, and environment hash.

## Implementation Roadmap

### Phase 1: Trajectory and Schema

- Add `bench/trajectory.ts` with normalized event types.
- Update runtime wrappers to write JSONL trajectories.
- Add report sections for event counts, subagent tree, skill loads, verification commands, and safety events.

### Phase 2: Complex Local Cases

- Add at least one case in each family: coding, terminal, subagent workflow, skill, dialogue/tool API, local web, memory, safety.
- Keep fixtures small enough for local runs but rich enough to require real tool use.
- Add `bench:complex` and `bench:complex:parity` scripts.

### Phase 3: User Simulator and Tool API

- Add a local TypeScript user simulator for Tau-bench-style cases.
- Add domain API tools backed by fixture JSON.
- Grade both task state and policy compliance.

### Phase 4: External Benchmark Adapters

- Add optional adapters rather than vendoring large suites:
  - SWE-bench style adapter for repository issue tasks.
  - Terminal-Bench/Harbor style task adapter.
  - WebArena-like local web fixture adapter.
- Keep these opt-in because they require heavier environments.

### Phase 5: Parity Analysis

- Compare Clean SDK, Bridge SDK, and official Claude Agent SDK by case family.
- Produce a gap report:
  - missing tool capability,
  - planner/loop failure,
  - subagent orchestration failure,
  - skill discovery/invocation failure,
  - permission mismatch,
  - cost or latency regression.

## Immediate Next Cases

The first implementation batch should add these cases:

1. `complex.coding.multi-file-regression`
2. `complex.workflow.subagent-review`
3. `complex.skills.release-checklist`
4. `complex.dialogue.policy-tool-api`
5. `complex.safety.prompt-injection-file`

These cover the biggest gap in the current smoke suite: they force real multi-step agent behavior while keeping evaluation deterministic.
