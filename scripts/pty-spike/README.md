# PTY/xterm de-risk smoke harness (Phase 0)

Standalone Electron smoke test that de-risks the native dependencies of the
workbench terminal engine (plan phase 3). It runs **headlessly** in the Electron
main process and asserts the two risks that gate the terminal engine.

## What it checks

1. **node-pty loads + spawns + captures inside Electron.** `node-pty@1.1.0` is an
   **N-API** module (`node-addon-api`). N-API is ABI-stable, so the prebuilt
   `.node` loads in Electron **without `electron-rebuild` and without MSVC/build
   tools**. The harness `require`s it in the Electron main process, spawns the
   platform shell, writes `echo SPIKE_OK`, and asserts the marker is captured.

2. **xterm renders under the relaxed CSP.** A hidden `BrowserWindow` loads
   `@xterm/xterm` (UMD, served same-origin) under
   `style-src 'self' 'unsafe-inline'`, writes `SPIKE_XTERM_OK`, reads it back
   from the terminal buffer, and reports any `securitypolicyviolation` events.

## Run

```bash
# from the repo root (Electron is installed there via optionalDependencies)
cd scripts/pty-spike
npm install                 # node-pty + @xterm/xterm + @xterm/addon-fit (prebuilts)
npm run smoke              # node ../../node_modules/electron/cli.js pty-xterm-smoke.cjs
# exits 0 only if BOTH checks pass
```

CI runs this via the `pty-spike` job in `.github/workflows/ci.yml`.

## Verified findings (2026-06, win-x64 + Node 22 + Electron 42.4.1)

| Risk | Result |
|---|---|
| node-pty install on win-x64 | prebuilt, no MSVC, `1.1.0` |
| PTY spawn + output capture | PASS (`SPIKE_OK`) |
| arm64 native (plan **R1**) | **resolved** — `win32-arm64` prebuilts ship (`pty.node`, `conpty.node`, `conpty.dll`, `OpenConsole.exe`, `winpty-agent.exe`) |
| N-API prebuilt loads in Electron 42.4.1 (NODE_MODULE_VERSION 146) | PASS, no electron-rebuild, no MSVC |
| xterm renders under `style-src 'self' 'unsafe-inline'` | PASS, **0 CSP violations** |

### Phase-3 packaging consequences (recorded here as the de-risk output)

- **No `electron-rebuild` needed.** N-API prebuilts are ABI-stable across
  Node/Electron. The `rebuild:pty` script the plan mentioned is unnecessary;
  skip it. (`asarUnpack` for `node_modules/node-pty/**` is **still required** —
  native `.node`/`.dll`/`.exe` files cannot be `dlopen`'d from inside an asar.)
- **xterm delivery.** `@xterm/xterm/lib/xterm.js` is a UMD bundle → attach
  `Terminal` to `window` via `<script src>`. `@xterm/addon-fit/lib/addon-fit.js`
  is also UMD but exposes the constructor as **`FitAddon.FitAddon`** (the whole
  exports object is the global). Phase 3 prefers the ESM builds
  (`lib/xterm.mjs`, `lib/addon-fit.mjs`) via dynamic `import()` for clean named
  imports (`{ Terminal }`, `{ FitAddon }`).
- **CSP.** Relax `style-src 'self'` → `style-src 'self' 'unsafe-inline'`
  (acceptable for a sandboxed desktop app; scripts stay nonce-gated).

## arm64 fallback decision (plan R1 — decide + document before phase 3)

The plan offered three fallbacks if arm64 native failed:

- **F1** — source-build on a `windows-11-arm` runner.
- **F2** — ship arm64 with the terminal pane feature-gated off (chat + monitor
  still work).
- **F3** — drop arm64 from the terminal-bearing release.

**Decision: F1 is unnecessary — prebuilts suffice.** `node-pty@1.1.0` ships
`win32-arm64` prebuilts and is N-API, so the arm64 build path is identical to
x64 (no source compilation on any runner). The terminal engine will work on
arm64 with no special handling.

**F2 remains the safety net** for the day a future `node-pty` version drops a
prebuilt for an arch we ship: `state().terminalCapable` (phase 3) already drives
the renderer to hide the terminal tab when the pty cannot load, so chat +
monitor keep working. We do **not** adopt F3 (dropping arm64) — it is unnecessary.
