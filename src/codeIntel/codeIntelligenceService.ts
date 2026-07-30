import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LspProcess } from './lspProcess.js';
import { LanguageServerRegistry } from './languageServerRegistry.js';
import type {
  CodeDiagnostic,
  CodeLocation,
  LanguageServerDefinition,
  WorkspaceSymbol,
} from './types.js';

interface ServerState {
  definition: LanguageServerDefinition;
  process: LspProcess;
  initialized: Promise<void>;
  documents: Map<string, number>;
}

export interface CodeIntelligenceServiceOptions {
  workDir: string;
  registry: LanguageServerRegistry;
  timeoutMs?: number;
}

export class CodeIntelligenceService {
  private readonly workDir: string;
  private readonly servers = new Map<string, ServerState>();
  private readonly diagnosticsByUri = new Map<string, CodeDiagnostic[]>();

  constructor(private readonly options: CodeIntelligenceServiceOptions) {
    this.workDir = path.resolve(options.workDir);
  }

  async workspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    const states = await this.allAvailableServers();
    const results = await Promise.all(states.map(async state => {
      const raw = await state.process.request<unknown[]>('workspace/symbol', { query });
      return Array.isArray(raw) ? raw.flatMap(symbol => normalizeSymbol(symbol)) : [];
    }));
    return results.flat().sort((left, right) =>
      left.name.localeCompare(right.name) || left.location.uri.localeCompare(right.location.uri)
    );
  }

  async definition(filePath: string, line: number, character: number): Promise<CodeLocation[]> {
    return this.locationRequest('textDocument/definition', filePath, line, character);
  }

  async references(filePath: string, line: number, character: number): Promise<CodeLocation[]> {
    return this.locationRequest('textDocument/references', filePath, line, character, {
      context: { includeDeclaration: true },
    });
  }

  async diagnostics(filePath?: string): Promise<CodeDiagnostic[]> {
    if (filePath) {
      const uri = await this.openDocument(filePath);
      return structuredClone(this.diagnosticsByUri.get(uri) ?? []);
    }
    return [...this.diagnosticsByUri.values()].flat().map(item => structuredClone(item));
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(state => state.process.dispose()));
    this.servers.clear();
  }

  private async locationRequest(
    method: string,
    filePath: string,
    line: number,
    character: number,
    extra: Record<string, unknown> = {},
  ): Promise<CodeLocation[]> {
    const definition = this.options.registry.forFile(filePath);
    if (!definition) throw new Error(`No language server is configured for ${path.extname(filePath) || filePath}.`);
    const state = await this.server(definition);
    const uri = await this.openDocument(filePath);
    const raw = await state.process.request<unknown>(method, {
      textDocument: { uri },
      position: { line: Math.max(0, line), character: Math.max(0, character) },
      ...extra,
    });
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return values.flatMap(value => normalizeLocation(value));
  }

  private async openDocument(filePath: string): Promise<string> {
    const absolute = await this.assertWorkspacePath(filePath);
    const definition = this.options.registry.forFile(absolute);
    if (!definition) throw new Error(`No language server is configured for ${path.extname(absolute)}.`);
    const state = await this.server(definition);
    const uri = pathToFileURL(absolute).href;
    if (!state.documents.has(uri)) {
      const text = await readFile(absolute, 'utf8');
      state.documents.set(uri, 1);
      state.process.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: definition.languages[0] ?? path.extname(absolute).slice(1),
          version: 1,
          text,
        },
      });
    }
    return uri;
  }

  private async assertWorkspacePath(filePath: string): Promise<string> {
    const absolute = path.resolve(this.workDir, filePath);
    const relative = path.relative(this.workDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Code intelligence path escapes workspace: ${absolute}`);
    }
    const rootReal = await realpath(this.workDir).catch(() => this.workDir);
    const targetReal = await realpath(absolute).catch(() => absolute);
    const realRelative = path.relative(rootReal, targetReal);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`Code intelligence path resolves outside workspace: ${absolute}`);
    }
    return absolute;
  }

  private async allAvailableServers(): Promise<ServerState[]> {
    const capabilities = await this.options.registry.capabilities();
    const available = new Set(capabilities.filter(item => item.available).map(item => item.id));
    return Promise.all(
      this.options.registry.list()
        .filter(definition => available.has(definition.id))
        .map(definition => this.server(definition)),
    );
  }

  private async server(definition: LanguageServerDefinition): Promise<ServerState> {
    const existing = this.servers.get(definition.id);
    if (existing) {
      await existing.initialized;
      return existing;
    }
    const process = new LspProcess({
      command: definition.command,
      args: definition.args,
      cwd: this.workDir,
      timeoutMs: this.options.timeoutMs,
      onNotification: (method, params) => {
        if (method === 'textDocument/publishDiagnostics') this.captureDiagnostics(params);
      },
    });
    const initialized = process.request('initialize', {
      processId: globalThis.process.pid,
      rootUri: pathToFileURL(this.workDir).href,
      capabilities: {},
      initializationOptions: definition.initializationOptions,
      workspaceFolders: [{ uri: pathToFileURL(this.workDir).href, name: path.basename(this.workDir) }],
    }).then(() => {
      process.notify('initialized', {});
    });
    const state: ServerState = {
      definition,
      process,
      initialized,
      documents: new Map(),
    };
    this.servers.set(definition.id, state);
    await initialized;
    return state;
  }

  private captureDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
    const diagnostics = params.diagnostics.flatMap(item => {
      if (!isRecord(item) || typeof item.message !== 'string') return [];
      const range = normalizeRange(item.range, params.uri);
      if (!range) return [];
      return [{
        uri: params.uri,
        message: item.message,
        ...(typeof item.severity === 'number' ? { severity: item.severity } : {}),
        ...(typeof item.source === 'string' ? { source: item.source } : {}),
        ...(typeof item.code === 'string' || typeof item.code === 'number' ? { code: item.code } : {}),
        range,
      } satisfies CodeDiagnostic];
    });
    this.diagnosticsByUri.set(params.uri, diagnostics);
  }
}

function normalizeSymbol(value: unknown): WorkspaceSymbol[] {
  if (!isRecord(value) || typeof value.name !== 'string') return [];
  const location = normalizeLocation(value.location)[0];
  if (!location) return [];
  return [{
    name: value.name,
    ...(typeof value.kind === 'number' ? { kind: value.kind } : {}),
    ...(typeof value.containerName === 'string' ? { containerName: value.containerName } : {}),
    location,
  }];
}

function normalizeLocation(value: unknown): CodeLocation[] {
  if (!isRecord(value)) return [];
  if (typeof value.uri === 'string') {
    const range = normalizeRange(value.range, value.uri);
    return range ? [range] : [];
  }
  if (typeof value.targetUri === 'string') {
    const range = normalizeRange(value.targetSelectionRange ?? value.targetRange, value.targetUri);
    return range ? [range] : [];
  }
  return [];
}

function normalizeRange(value: unknown, uri: string): CodeLocation | undefined {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return undefined;
  if (typeof value.start.line !== 'number' || typeof value.start.character !== 'number') return undefined;
  return {
    uri,
    line: value.start.line,
    character: value.start.character,
    ...(typeof value.end.line === 'number' ? { endLine: value.end.line } : {}),
    ...(typeof value.end.character === 'number' ? { endCharacter: value.end.character } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
