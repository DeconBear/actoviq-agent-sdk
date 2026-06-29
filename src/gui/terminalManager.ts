// TerminalManager — holds N node-pty spawns for the workbench terminal panes
// (plan phase 3). Each terminal has a capped output ring (late-joiner replay),
// a live subscriber set, and an offscreen @xterm/headless instance fed the same
// pty stream so an agent can snapshot the screen as text (plan phase 6).
//
// node-pty + @xterm/headless are loaded via dynamic import + feature gate so the
// published SDK package and Linux CI never require the native module: if the
// import fails (prebuilt missing / wrong arch), ptyAvailable() returns false and
// the GUI hides the terminal tab. The types below are local shapes — they avoid
// `typeof import('node-pty')` so a typecheck pass does not need the packages.
import { randomUUID } from 'node:crypto';

interface NodePtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(file: string, args: string[] | string, options: {
    name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string>;
  }): NodePtyProcess;
}
interface HeadlessBufferLine {
  translateToString(trimRight?: boolean): string;
}
interface HeadlessTerminal {
  write(data: string, cb?: () => void): unknown;
  resize(cols: number, rows: number): void;
  dispose(): void;
  buffer: { active: { length: number; baseY: number; getLine(i: number): HeadlessBufferLine | null } };
}

export interface TerminalSpawnOptions {
  cwd?: string;
  cmd?: string;       // override the default shell
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface TerminalInfo {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  cmd: string;
  alive: boolean;
}

// Per-terminal output ring cap. 64 KiB is enough scrollback for a late joiner to
// see recent context without unbounded memory growth on a long-running shell.
const RING_CAP = 64 * 1024;

interface ManagedTerminal {
  id: string;
  proc: NodePtyProcess;
  headless: HeadlessTerminal | null;
  cols: number;
  rows: number;
  cwd: string;
  cmd: string;
  ring: string;                 // capped tail of all emitted output
  exited: boolean;
  exitCode: number | null;
  subscribers: Set<TerminalSubscriber>;
}
interface TerminalSubscriber {
  onData(data: string): void;
  onExit(code: number | null): void;
}

let nodePty: NodePtyModule | null = null;
let HeadlessCtor: (new (opts: { cols: number; rows: number; allowProposedApi: boolean }) => HeadlessTerminal) | null = null;
let probed = false;

/** Best-effort one-time probe. Returns true if node-pty loaded (native prebuilt OK). */
export async function ptyAvailable(): Promise<boolean> {
  if (probed) return nodePty !== null;
  probed = true;
  try {
    const mod = await import('node-pty') as unknown as NodePtyModule & { default?: NodePtyModule };
    nodePty = mod.default ?? mod;
  } catch {
    nodePty = null;
  }
  try {
    const hp = await import('@xterm/headless') as unknown as { default?: { Terminal?: unknown }; Terminal?: unknown };
    const Ctor = (hp.default ?? hp).Terminal as (new (opts: { cols: number; rows: number; allowProposedApi: boolean }) => HeadlessTerminal) | undefined;
    HeadlessCtor = Ctor ?? null;
  } catch {
    HeadlessCtor = null; // headless is optional — only phase-6 snapshot needs it
  }
  return nodePty !== null;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: [] };
  }
  return { file: process.env.SHELL || 'sh', args: [] };
}

export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();

  create(opts: TerminalSpawnOptions = {}): string | null {
    if (!nodePty) return null;
    const cols = Math.max(8, Math.floor(opts.cols ?? 80));
    const rows = Math.max(2, Math.floor(opts.rows ?? 24));
    const cwd = opts.cwd || process.cwd();
    const shell = opts.cmd ? { file: opts.cmd, args: opts.args ?? [] } : defaultShell();
    const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
    const proc = nodePty.spawn(shell.file, shell.args, {
      name: 'xterm-256color', cols, rows, cwd, env,
    });
    const id = randomUUID();
    const headless = HeadlessCtor
      ? new HeadlessCtor({ cols, rows, allowProposedApi: true })
      : null;
    const term: ManagedTerminal = {
      id, proc, headless, cols, rows, cwd, cmd: shell.file,
      ring: '', exited: false, exitCode: null, subscribers: new Set(),
    };
    proc.onData((data) => {
      // Ring: keep the last RING_CAP bytes (drop from the front).
      term.ring += data;
      if (term.ring.length > RING_CAP) {
        term.ring = term.ring.slice(term.ring.length - RING_CAP);
      }
      // Headless render is async (write returns once parsed); fire-and-forget.
      try { term.headless?.write(data); } catch { /* headless best-effort */ }
      for (const sub of term.subscribers) {
        try { sub.onData(data); } catch { /* a slow subscriber must not block others */ }
      }
    });
    proc.onExit(({ exitCode }) => {
      term.exited = true;
      term.exitCode = exitCode;
      for (const sub of term.subscribers) {
        try { sub.onExit(exitCode); } catch { /* ignore */ }
      }
      term.subscribers.clear();
    });
    this.terminals.set(id, term);
    return id;
  }

  /** Replay the ring, then stream live data + exit. Returns an unsubscribe fn. */
  subscribe(id: string, onData: (data: string) => void, onExit: (code: number | null) => void): () => void {
    const term = this.terminals.get(id);
    if (!term) return () => undefined;
    if (term.ring) {
      // Defer the replay so the caller can attach its NDJSON writer first.
      queueMicrotask(() => {
        try { onData(term.ring); } catch { /* ignore */ }
        if (term.exited) {
          try { onExit(term.exitCode); } catch { /* ignore */ }
        }
      });
    } else if (term.exited) {
      queueMicrotask(() => { try { onExit(term.exitCode); } catch { /* ignore */ } });
    }
    if (!term.exited) {
      const sub: TerminalSubscriber = { onData, onExit };
      term.subscribers.add(sub);
      return () => { term.subscribers.delete(sub); };
    }
    return () => undefined;
  }

  write(id: string, data: string): boolean {
    const term = this.terminals.get(id);
    if (!term || term.exited) return false;
    try { term.proc.write(data); return true; } catch { return false; }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const term = this.terminals.get(id);
    if (!term || term.exited) return false;
    const c = Math.max(8, Math.floor(cols));
    const r = Math.max(2, Math.floor(rows));
    try {
      term.proc.resize(c, r);
      term.headless?.resize(c, r);
      term.cols = c; term.rows = r;
      return true;
    } catch { return false; }
  }

  kill(id: string): boolean {
    const term = this.terminals.get(id);
    if (!term) return false;
    try { term.proc.kill(); } catch { /* already dead */ }
    try { term.headless?.dispose(); } catch { /* ignore */ }
    return this.terminals.delete(id);
  }

  info(id: string): TerminalInfo | null {
    const term = this.terminals.get(id);
    if (!term) return null;
    return { id, cols: term.cols, rows: term.rows, cwd: term.cwd, cmd: term.cmd, alive: !term.exited };
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map(t => ({ id: t.id, cols: t.cols, rows: t.rows, cwd: t.cwd, cmd: t.cmd, alive: !t.exited }));
  }

  /** Offscreen screen snapshot for agent TUI vision (plan phase 6). */
  snapshot(id: string, maxRows = 50): string | null {
    const term = this.terminals.get(id);
    if (!term || !term.headless) return null;
    const buf = term.headless.buffer.active;
    const total = buf.length;
    const start = Math.max(0, total - maxRows);
    const lines: string[] = [];
    for (let i = start; i < total; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }
}
