import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export interface LspProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: unknown) => void;
}

export class LspProcess {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly timeoutMs: number;

  constructor(private readonly options: LspProcessOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.drain();
    });
    child.stderr.on('data', () => {
      // Server stderr is diagnostic only; JSON-RPC stays on stdout.
    });
    child.once('error', error => this.rejectAll(error));
    child.once('exit', (code, signal) => {
      this.child = undefined;
      this.rejectAll(new Error(`Language server exited (${code ?? signal ?? 'unknown'}).`));
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.start();
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language server request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.start();
    this.send({ jsonrpc: '2.0', method, params });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await this.request('shutdown');
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      this.notify('exit');
      await Promise.race([
        exited,
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 500);
          timer.unref?.();
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      child.kill();
    }
    this.child = undefined;
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('Language server is not running.');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private drain(): void {
    while (true) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString('ascii');
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/iu);
      if (!match) {
        this.buffer = this.buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(body) as JsonRpcResponse;
      } catch {
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: JsonRpcResponse): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(
          `Language server error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.options.onNotification?.(message.method, message.params);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
