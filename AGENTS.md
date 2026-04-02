# Repository Guidelines

## Project Structure & Module Organization

Core source lives in `src/`. Key areas include `src/runtime` for the clean SDK loop, `src/parity` for bridge helpers, `src/memory` for session-memory and compact logic, `src/buddy` for companion features, and `src/workspace` for workspace helpers. Tests live in `tests/` and use `*.spec.ts` naming. Examples live in `examples/`; keep them runnable through npm scripts. `scripts/` contains build, sync, and packaging helpers. `vendor/actoviq-runtime` contains the bundled non-TUI runtime assets. Do not edit `dist/` directly; it is generated.

## Build, Test, and Development Commands

- `npm run typecheck`: run TypeScript checks with no emit.
- `npm test`: run the Vitest suite once.
- `npm run build`: clean `dist/` and compile the package.
- `npm pack --dry-run`: verify the publishable npm package contents.
- `npm run smoke`: run the live smoke script against local configuration.
- `npm run example:quickstart`: run the basic SDK example.
- `npm run example:actoviq-interactive-agent`: launch the interactive streaming demo.

## Coding Style & Naming Conventions

Use TypeScript with ESM imports and 2-space indentation. Prefer small, focused modules and explicit types on exported APIs. Use `camelCase` for functions and variables, `PascalCase` for classes and exported types, and descriptive file names such as `actoviqCompact.ts` or `agent-client.spec.ts`. Keep public naming Actoviq-branded. Avoid editing generated assets or introducing secrets into tracked files.

## Testing Guidelines

Vitest is the test runner. Add or update tests for any runtime, memory, compact, bridge, or API-surface change. Keep tests in `tests/` and mirror the feature under test. Favor behavior-level assertions over snapshot-heavy tests. Before opening a PR, run `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run`.

## Commit & Pull Request Guidelines

Follow the existing commit style: `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `ci: ...`. Keep messages imperative and scoped to the change. PRs should include a short summary, linked issue if applicable, validation steps run locally, and any docs/example updates required by API changes. Include terminal output or screenshots only when they clarify behavior.

## Security & Configuration Tips

Never commit real credentials. Local config should live outside Git, for example in `~/.actoviq/settings.json` or ignored local JSON files. The `plan/` directory is intentionally local-only and excluded from Git and npm packaging.
