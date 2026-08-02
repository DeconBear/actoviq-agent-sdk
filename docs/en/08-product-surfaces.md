# SDK, CLI/TUI, and GUI surface policy

Last verified: 2026-08-02.

This document defines which differences between the Hadamard SDK, terminal UI, and desktop GUI are intentional. It is a current product contract, not a promise that every SDK symbol must receive a button.

`hadamard-tui` is the only interactive terminal agent. Other binaries such as `hadamard-gui`, `hadamard-app-server`, and `hadamard-link-runtime` are launchers or service adapters, not competing terminal agents.

## The three layers

### Layer 1: shared runtime and command contracts

These behaviors must have the same meaning wherever they are exposed:

- model execution, streaming, Sessions, context accounting, usage, and interruption;
- tools, permission decisions, Plan mode, checkpoints, diffs, memory, and goals;
- lifecycle hooks, MCP, skills, plugins, agents, teams, Bridge runtimes, issues, Manager, and Assistant;
- command names, second-level commands, usage text, and completion behavior in TUI and GUI;
- normalized events, parent/child run identity, redaction, and terminal states.

The command registry in [`src/ui/commandSurface.ts`](../../src/ui/commandSurface.ts) is authoritative for both interactive products. [`tests/cli-convergence.spec.ts`](../../tests/cli-convergence.spec.ts) rejects a command or subcommand that is registered without a TUI and GUI handler.

### Layer 2: curated product controls

The TUI and GUI expose user-facing subsets of Layer 1, plus controls that fit their medium:

- the GUI owns visual Project views, the Agent Graph canvas, Workflow tree editing, Automation forms, desktop screenshots, custom keyboard shortcuts, application updates, data-root migration, and desktop terminal/Git panels;
- the TUI owns ANSI-native scrollback, terminal selection dialogs, and a keyboard-first prompt surface;
- both products use the shared slash-command contract, but may render the result differently;
- a product control must call the same runtime/persistence contract instead of maintaining a second implementation.

A visual or OS-specific feature missing from the TUI is not a parity defect. A command with different meaning, a different permission result, or a different persisted format is a parity defect.

### Layer 3: developer and host APIs

The SDK intentionally has the widest surface. The following families do not require direct TUI or GUI controls:

- provider adapters and capability declarations;
- custom model request parameters, tools, schemas, middleware, and content processors;
- runtime services, storage adapters, Session CAS/fork primitives, event sinks, tracing, and redaction policies;
- orchestration primitives, workflow executors, schedulers, durable stores, and custom background runners;
- Node/host adapters, sandbox integrations, transport adapters, and compatibility façades.

Products should add a control only when users can make a coherent decision with it. Optional sampling fields may remain unset so the selected provider/runtime keeps its own default. The SDK may expose additional parameters without creating a parity obligation.

## Current capability matrix

| Capability | SDK | `hadamard-tui` | Desktop GUI | Contract |
|---|---|---|---|---|
| Run, stream, interrupt, resume Session | Full API | Interactive | Interactive | Layer 1, same Session and event semantics |
| Model, effort, output style, routing | Full API | Slash commands and pickers | Composer and Settings | Layer 1 behavior; Layer 2 presentation |
| Tools and permissions | Custom definitions and policy APIs | Permission dialogs and presets | Permission dialogs and presets | Layer 1 decisions and audit semantics |
| Typed lifecycle hooks | Full config/runtime API | Shared `/hooks` inspection | Full editor and inspection | Layer 1 runtime; GUI is the richer editor |
| Agent profiles and execution trees | Full API | `/agents` browsing | Picker, settings, and Project execution view | Layer 1 data, Layer 2 views |
| Teams and Agent Workflow squads | Full API | `/team` run/attach | Agent Graph and Workflow editors | Shared persisted team definitions and execution |
| Automation tasks | Scheduling/persistence API | `/automation list/new` | Automation list, editor, run controls | Same task file; scheduler is hosted by GUI/app server |
| Dynamic workflow scripts | Trusted compatibility API | `/workflows` | Shared `/workflows` command | Legacy/developer surface, not the Agent Workflow editor |
| Bridge and external CLI runtimes | Full API | `/bridge` | Composer and Settings | Shared config and lifecycle semantics |
| Projects, issues, Manager, Assistant | Full host APIs | Shared commands | Product regions and dialogs | Shared persistence and command meaning |
| Desktop screenshot and custom shortcuts | Host API where applicable | No desktop UI | Native controls | Intentional Layer 2 GUI capability |
| Provider/middleware/storage/executor composition | Full API | Not directly exposed | Not directly exposed | Intentional Layer 3 SDK capability |

## Two Workflow formats

Hadamard currently preserves two different formats and does not silently convert between them:

1. **Agent Workflow** is a `TeamDefinition` with `squadType: "workflow"`. It is created and edited on the GUI Agent page, runs through the shared team member runtime, and is the target offered for new Automation tasks.
2. **Dynamic workflow script** is trusted JavaScript loaded from `.hadamard/workflows`. It remains available through the SDK and `/workflows` for compatibility and developer use.

New Automation tasks persist `workflowSource: "agent"`. Historical tasks without this marker continue to use the dynamic script runtime, so upgrading does not reinterpret an existing task with the same name.

## Change rules

When adding or changing a capability:

1. Decide its layer before adding UI.
2. Put shared command names and subcommands in `src/ui/commandSurface.ts`.
3. Reuse the same runtime, persistence, event, and permission contracts from both products.
4. Add TUI/GUI parity tests for Layer 1 commands; add product-specific tests for Layer 2 controls.
5. Document an intentional SDK-only family here instead of adding a placeholder or empty UI.
