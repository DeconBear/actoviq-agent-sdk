---
title: Model Team & Multi-Model Agent Design — A Research Report
date: 2026-06-17
---

# Model Team & Multi‑Model Agent Design — A Research Report

*Published 2026‑06‑17 · Agent design research & experimental record*

This post is part design reference, part research report. It documents the
**Model Team** subsystem (multi‑model cooperation) and the empirical
investigation that answered a single question: *does letting an agent convene a
team of models actually produce better results — and if so, when, and at what
cost?*

The short answer, established over 48 graded runs: the autonomous team **works
as designed and is safe to keep**, **modestly improves citation and structure
quality**, **never regresses on average**, and **costs ~20% more** — so leaving
the decision to the model (rather than forcing collaboration) is exactly right.
The longer answer, and the design lessons behind it, are below.

---

## 1. Model Team design

A **Model Team** is multi‑model cooperation on a single prompt. Unlike a
**Swarm** (long‑lived supervised peers with mailboxes) or a **Workflow**
(scripted multi‑agent control flow), a team is synchronous: `team.ask(prompt)`
fans the work across models and returns one result.

Every mode follows the **Hadamard Agent Harness principle**:

> Provide scaffolding, not constraints. The SDK offers the communication
> channels, model routing, tool access, and context accumulation — but the
> models decide when to converge, when to iterate, and what is good enough.
> No artificial iteration caps; no forced convergence.

### 1.1 Modes

| Mode | Pattern | Who decides |
|---|---|---|
| **panel** | N models answer in parallel → a primary synthesizes, optionally over multiple rounds | Primary model converges autonomously |
| **router** | A classifier dispatches to a user‑defined specialist | User‑configured categories |
| **discussion** | Members speak in turn each round; a facilitator summarizes; the primary rules | Primary (can override the facilitator) |
| **executor‑reviewer** | An executor owns the output; a reviewer advises; the executor accepts/rejects | Executor has final authority |
| **analysis** | N independent **read‑only ReAct agents** investigate and each return a findings report | The *calling* agent — the team only advises |

The `analysis` mode is the one this report focuses on, because it is the form
that an agent invokes as a tool while it works.

### 1.2 The autonomous expert panel (`analysis` mode)

Each panel member is an **independent, read‑only ReAct agent** with a curated,
non‑destructive toolset:

```
Read · Glob · Grep · TavilySearch · WebFetch
```

No `Write`, `Edit`, `Bash`, or delegation tools — members can investigate the
project and the web over multiple rounds, but they cannot change anything, and
(because they have no delegation tools) they cannot recurse. Each member returns
a **findings report**; the tool returns the labeled reports. By default (no
`primary`) there is no internal synthesizer and no convergence loop: **the
calling agent stays in control and decides what, if anything, to incorporate.**
Adding a `primary` turns on an optional convergence loop — the primary
synthesizes the findings and decides `FINALIZE`/`CONTINUE` across rounds (the
Harness safety cap `maxRounds` still applies).

Exposed as a tool with `createTeamTool`, this becomes an `expert-panel` that a
main agent may call when a second set of eyes genuinely helps:

```ts
const expertPanel = sdk.createTeamTool({
  name: 'expert-panel',
  mode: 'panel-analysis', // advisory; add a `primary` for multi-round convergence
  members: [
    { model: 'deepseek-v4-pro',
      systemPrompt: 'Expert researcher. Deep, source-grounded analysis.' },
    { model: 'MiniMax-M3', provider: 'anthropic',
      baseURL: 'https://api.minimaxi.com/anthropic/v1', apiKey: '$MINIMAX_API_KEY',
      systemPrompt: 'Rigorous skeptic. Verify with sources; challenge assumptions.' },
  ],
  timeoutMs: 300_000,
  maxIterations: 12, // per-member ReAct depth cap
});

const sdk = await createAgentSdk({ tools: [createTavilySearchTool(), expertPanel] });
```

The agent now decides, turn by turn, whether to consult the panel — exactly the
Harness principle in action.

### 1.3 Infrastructure

- **Per‑member provider independence** — each member has its own `model`,
  `provider`, `baseURL`, and `apiKey` (with `$ENV_VAR` resolution).
- **Global `AgentPool`** — one shared concurrency cap (`min(16, cores − 2)`)
  across workflows, teams, and swarms.
- **Cost tracking** — per‑model token accounting plus a pricing table
  (`src/team/pricing.ts` + `~/.actoviq/pricing.json` override); `estimatedCost`
  is `null` when pricing is unknown.
- **Persistence** — team definitions live in `.actoviq/teams/` (project) and
  `~/.actoviq/teams/` (personal); reachable from the TUI via `/team`.

### 1.4 An optional orchestration layer

For users who want a *deterministic* pipeline instead of model‑autonomous
convening, the same primitives compose into a Dynamic Workflow —
`main → read‑only panel → full‑permission sub‑agent → re‑evaluate → loop` —
shipped as `expert-orchestration` and runnable from the TUI with
`/workflows run expert-orchestration <task>`. The autonomous tool and the
scripted workflow are complementary: one trusts the model to decide, the other
encodes a fixed control flow.

---

## 2. The research question

A multi‑model panel is widely assumed to beat a single model. But an *agent that
can optionally convene a panel* is a different thing from a panel that always
runs. Two questions had to be separated:

1. **Does the agent actually convene the panel on its own?** (Is the Harness
   mechanism real, or does the model ignore an optional tool?)
2. **When it does, does quality improve — and at what cost?**

To answer them we needed a benchmark that measures *real* capability, not just
prose, and that is robust to the noise of single runs.

---

## 3. Benchmark methodology

The standard benchmark (`bench/standard/`) has two complementary tracks.

**Knowledge track** — self‑contained analysis/reasoning prompts, graded by an
LLM judge on five independent dimensions (factual, breadth, structure, citation,
efficiency). The judge's rationale is stored, and malformed judge output is
flagged and excluded rather than silently scored zero.

**Execution track** — real fixture projects (a planted‑bug fix; a multi‑module
CSV pipeline implemented from a spec‑defining test suite). The agent works with
the **full toolset** (`Read/Write/Edit/Bash/…`) in an **isolated temp
workspace**, then an **objective verifier** (`node --test`) decides pass/fail.
No LLM judge — the work either passes or it doesn't. Files the agent changed are
recorded.

Three principles made the results trustworthy:

- **Hold the model constant.** Every agent runs `deepseek-v4-pro`; the *harness*
  is the only variable. Web search is held constant across harnesses (no MCP).
- **Score every dimension separately.** A single composite hides trade‑offs;
  quality dimensions, tool count, token consumption, latency, and verifier
  pass‑rate are each reported on their own.
- **Repeat trials.** Single runs proved wildly noisy (one task swung 6.8 → 9.8
  on identical configuration), so the head‑to‑head ran **3× per task**.

> A methodological aside: building this surfaced several real bugs the work
> depended on — a strict tool schema that intermittently dropped the panel, a
> working‑directory mismatch that made the agent read the wrong folder and give
> up, and a Windows glob bug that meant the suite had never actually run. Each
> is a reminder that "the benchmark says X" is only as good as the harness
> underneath it.

---

## 4. Results

Head‑to‑head, **Hadamard SDK** (single agent) vs **Hadamard+Team** (same agent
with the `expert-panel` tool available), 3 trials × 8 tasks = 48 graded runs,
24 per agent.

### 4.1 Per‑dimension averages

| dimension | Single agent | + Expert Panel | read |
|---|---|---|---|
| quality (composite) | 8.7 | **8.8** | tie (within noise) |
| factual | 7.9 | 7.8 | tie — **the ceiling for both** |
| breadth | 9.6 | 9.6 | tie |
| structure | 9.6 | **9.8** | small panel edge |
| **citation** | 7.4 | **8.0** | **panel +0.6** — better source grounding |
| efficiency (judge) | 8.6 | 8.4 | tie |
| tool calls | **8.4** | 9.5 | panel ≈ +1 call |
| tokens (thousands) | **14.3** | 17.1 | **+~20%** |
| wall‑clock (seconds) | **136** | 161 | **+~18%** |
| execution pass‑rate | 100% | 100% | both fully capable |

### 4.2 Did the agent convene the panel?

**Yes — selectively.** Across the knowledge runs the agent autonomously called
`expert-panel` in **~39% of runs** (and never on the quick coding tasks, where
it just wrote the fix). The tool histogram: `TavilySearch ×152`,
`expert-panel ×7`, `Skill ×2`. The Harness mechanism is real: the model decides,
and it decides to consult the panel on harder, open‑ended analysis — exactly
where a second perspective should help.

### 4.3 Per‑task quality (overall average)

| task | Single | + Panel |
|---|---|---|
| architecture‑decision | 8.80 | 8.63 |
| security‑review | **9.57** | 9.07 |
| coding‑multi‑file‑regression | 9.07 | 8.97 |
| reasoning‑dialogue‑policy | 8.80 | **9.47** |
| reasoning‑performance‑debug | 8.93 | 8.87 |
| safety‑prompt‑injection | 6.87 | **7.63** |
| execution (csv‑pipeline, fix‑failing‑test) | 100% | 100% |

The team wins dialogue and safety, the single agent wins security, the rest tie
— a wash on the composite, with the panel's edge concentrated in citation and
structure.

---

## 5. What we learned

**1. "Provide scaffolding, not constraints" is empirically sound.** An earlier
design *forced* the panel to run after the agent finished and synthesize a new
answer; it replaced a strong answer with a compressed one and **hurt** quality.
Making the panel an *optional, advisory* tool — and trusting the model to decide
when to call it — both removed the regression and produced selective, sensible
use. Forcing collaboration is worse than offering it.

**2. Single‑run benchmarks lie.** The most dramatic early "finding" — that the
team badly hurt the safety task (−2.7) — evaporated under repeated trials: over
three runs the team actually scored *higher* on safety (7.63 vs 6.87), with both
agents swinging across a 3‑point range. Per‑task deltas from a single run are
noise. Repeat, or don't conclude.

**3. Composite scores hide the story; measure each axis.** The headline was a
tie (8.7 ≈ 8.8). Only the per‑dimension view revealed the real trade: the team
buys a **citation/structure improvement** for **~20% more tokens and time**.
A single number would have told you "no difference" and you'd have missed both
the benefit and the cost.

**4. Objective verification beats a judge for capability.** The execution track
— full tools, isolated workspace, `node --test` as the grader — gave an
unambiguous 100% pass for both agents on real coding tasks, including a
multi‑module implementation from a spec. No prose‑grading ambiguity: the tests
pass or they don't.

**5. Beware demand‑induced failure modes.** The single largest quality drag on
*both* agents was **citation fabrication** — factual accuracy plateaued at ~7.8
because the prompt's "include a Sources section with hyperlinks" pushed the model
to invent plausible, future‑dated references on conceptual tasks it already knew.
A capability the harness *demands* but cannot *ground* becomes a hallucination
vector. The read‑only research panel mitigates it slightly (citation +0.6) but
does not cure it; the real fix is to stop demanding citations the model can't
verify.

---

## 6. Practical guidance

- **Use the autonomous `expert-panel` tool** when tasks are open‑ended and
  benefit from independent perspectives (architecture, policy, security
  analysis). Expect a modest citation/structure lift and a ~20% cost premium,
  and let the model decide when to convene it — that selectivity is the point.
- **Don't force it.** A mandatory panel that rewrites the agent's answer is a
  net negative; keep it advisory.
- **For code/production tasks, prefer execution verification.** Give the agent
  full tools in an isolated workspace and grade on a real verifier, not a judge.
- **Always run multiple trials and report dimensions separately.** A composite
  over one run will mislead you in both directions.
- **Audit your prompts for demands you can't ground.** If you require citations,
  require the agent to *verify* them — or don't require them on tasks it answers
  from knowledge.

---

## 7. Reproducing this

```bash
# Knowledge + execution tracks, both agents, 3 trials each, 4 in parallel:
BENCH_AGENTS="Hadamard SDK,Hadamard+Team" BENCH_TRIALS=3 BENCH_CONCURRENCY=4 \
  npx tsx bench/standard/run-all.ts

# A subset (cost control):
BENCH_TASKS="analysis-security-review" BENCH_AGENTS="Hadamard+Team" \
  npx tsx bench/standard/run-all.ts
```

Per‑run records (answers, per‑dimension scores, judge comments, tool
trajectories, changed files) append to `bench/results/benchmark-record.json`;
the end‑of‑run summary prints the per‑dimension table above.
