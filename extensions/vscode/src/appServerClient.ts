import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';

import {
  decodeAppServerMessage,
  encodeAppServerRequest,
} from './appServerProtocol.js';

export class AppServerClient implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private readonly notificationEmitter = new vscode.EventEmitter<AppServerNotification>();
  readonly onNotification = this.notificationEmitter.event;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.ensureStarted();
    const id = `vscode-${++this.sequence}`;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
    });
    this.child!.stdin.write(encodeAppServerRequest(id, method, params));
    return result;
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error('App-server stopped.'));
    this.pending.clear();
    this.notificationEmitter.dispose();
  }

  private ensureStarted(): void {
    if (this.child) return;
    const config = vscode.workspace.getConfiguration('actoviq.appServer');
    const command = config.get<string>('command', 'actoviq-app-server');
    const args = config.get<string[]>('args', []);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.child = spawn(command, [...args, ...(workspace ? [workspace] : [])], {
      stdio: 'pipe',
      windowsHide: true,
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = decodeAppServerMessage(line);
      if (!message) return;
      if (message.type === 'event' && typeof message.method === 'string') {
        this.notificationEmitter.fire({
          method: message.method,
          params: message.params ?? {},
        });
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.child.once('exit', () => {
      this.dispose();
    });
    this.child.once('error', error => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }
}

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}
