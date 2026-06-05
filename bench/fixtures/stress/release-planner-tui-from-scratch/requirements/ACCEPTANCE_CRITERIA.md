# Acceptance Criteria

- `npm test` passes.
- `npm run build` passes when a build script is present.
- CLI writes a JSON plan for a valid manifest.
- CLI validation fails on dependency cycles.
- Blocked packages never appear in waves.
- Wave capacity is respected.
- Dependency order is respected.
- `explain` describes a package's wave, owner, risk, and dependencies.
- `tui --snapshot` prints stable terminal output containing `Wave`, `Critical Path`, `Risk`, and `Blockers`.
- The project includes `README.md`, `docs/engineering-plan.md`, `docs/design.md`, and `docs/test-plan.md`.
