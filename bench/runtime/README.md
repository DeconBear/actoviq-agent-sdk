# Runtime performance baseline

This harness measures real SDK runtime components with deterministic, in-memory
providers and MCP clients. It never opens a model/MCP network connection. Every
metric contains raw samples plus p50/p95; correctness and bounded-resource
properties are separate invariants so CI does not depend on absolute timings.

Run the short PR/CI workload:

```sh
tsx bench/runtime/run.ts --mode smoke --output tmp/runtime-smoke.json
```

Run the full baseline. Full mode includes SQLite at 10k and 100k items and one
million stream deltas:

```sh
tsx bench/runtime/run.ts --mode full --output tmp/runtime-full.json
```

Workload sizes are configurable, for example:

```sh
tsx bench/runtime/run.ts --mode full --session-items 10000,100000 --stream-deltas 1000000 --samples 7 --output tmp/runtime-full.json
```

Compare a report with a supplied baseline. Both p50 and p95 are checked and a
change greater than 10% fails:

```sh
tsx bench/runtime/compare.ts --baseline bench/runtime/baselines/main.json --current tmp/runtime-full.json --threshold 10
```

A known regression can only be accepted explicitly. The acknowledgement is
written into comparison JSON and should include the reason and a tracking issue
or change reference:

```sh
tsx bench/runtime/compare.ts --baseline baseline.json --current current.json --acknowledge "Accepted for ACT-123: safer validation adds one pass"
```

The stable output contract is [`report.schema.json`](./report.schema.json).
Heap samples are informational because garbage collection varies by machine;
stream boundedness is instead gated by exact queue-capacity invariants.
