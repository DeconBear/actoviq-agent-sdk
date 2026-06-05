# Release Train Planner Product Spec

Build a small but complete release planning project.

The tool reads a release train manifest with packages:

- `name`
- `owner`
- `risk`: `low`, `medium`, or `high`
- `dependsOn`: package names
- `blocked`: boolean

It must produce dependency-safe release waves. Blocked packages are not scheduled. No wave may exceed `capacityPerWave`.

Required CLI commands:

- `plan --input <file> --output <file>`
- `validate --input <file>`
- `explain --input <file> --package <name>`
- `tui --input <file> --snapshot`

The TUI snapshot can be plain terminal text, but it must include wave, package, owner or risk context, critical path, and blockers.
