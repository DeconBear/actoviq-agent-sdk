# Benchmark Adapter Framework

The repository-local benchmark harness should stay small and deterministic. Larger external suites such as SWE-bench, Terminal-Bench, WebArena, and OSWorld should be integrated through adapters rather than vendored wholesale.

Use `external-task-adapter.ts` to convert a small manifest into local benchmark case JSON files. The adapter is intentionally generic: it expects callers to provide a fixture path and grader commands that are already runnable in this repository's environment.

Example:

```bash
npx tsx bench/adapters/external-task-adapter.ts --manifest bench/adapters/examples/external-manifest.example.json --out-dir bench/cases/adapted
```

Manifest entries map to `BenchmarkCase` fields:

- `id`
- `title`
- `category`
- `instruction`
- `fixture`
- `graders`
- `tags`
- `budget`

Adapter-specific `source` values such as `swe-bench`, `terminal-bench`, `webarena`, and `osworld` are stored as tags and notes. The adapter does not hide tests by itself; the fixture and grader commands remain responsible for that.
