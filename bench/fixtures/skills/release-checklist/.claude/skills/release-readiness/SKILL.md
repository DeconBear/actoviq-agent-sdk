# Release Readiness

Use this skill when a task asks for release readiness, release validation, or release sign-off.

## Workflow

1. Run or inspect the package test command.
2. Read `release.json` and confirm the target version and test state.
3. Read `CHANGELOG.md` and confirm there is an entry for the target version.
4. Write `release-report.md` with these exact fields:
   - `Status: ready` only when tests pass and the changelog is updated.
   - `Tests: pass` or `Tests: fail`.
   - `Changelog: updated` or `Changelog: missing`.
