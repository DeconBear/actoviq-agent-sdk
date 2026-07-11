/**
 * Pure transcript parts model + GuiRunEvent reducer.
 * Shared by unit tests and (via mirrored logic) the browser client bundle.
 */

export type ToolPartState =
  | 'input-streaming'
  | 'running'
  | 'success'
  | 'error'
  | 'awaiting-approval'
  | 'awaiting-answer';

export type TranscriptPartKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'system'
  | 'error'
  | 'notice';

export interface TranscriptToolPart {
  id: string;
  kind: 'tool';
  toolName: string;
  toolUseId: string;
  state: ToolPartState;
  input?: unknown;
  outputText?: string;
  ok?: boolean;
  durationMs?: number;
  hint?: string;
  collapsed?: boolean;
  permissionId?: string;
  permissionSummary?: string;
}

export interface TranscriptTextPart {
  id: string;
  kind: 'user' | 'assistant' | 'system' | 'error' | 'notice' | 'thinking';
  text: string;
  streaming?: boolean;
  collapsed?: boolean;
}

export type TranscriptPart = TranscriptToolPart | TranscriptTextPart;

export interface GuiRunEventLike {
  type: string;
  [key: string]: unknown;
}

export interface TranscriptStore {
  parts: TranscriptPart[];
  /** toolUseId → part index */
  toolIndex: Map<string, number>;
  currentAssistantId: string | null;
  currentThinkingId: string | null;
  seq: number;
}

export function createTranscriptStore(): TranscriptStore {
  return {
    parts: [],
    toolIndex: new Map(),
    currentAssistantId: null,
    currentThinkingId: null,
    seq: 0,
  };
}

export function resetTranscriptStore(store: TranscriptStore): void {
  store.parts = [];
  store.toolIndex.clear();
  store.currentAssistantId = null;
  store.currentThinkingId = null;
  store.seq = 0;
}

function nextId(store: TranscriptStore, prefix: string): string {
  store.seq += 1;
  return `${prefix}-${store.seq}`;
}

function finalizeStreamingText(store: TranscriptStore): void {
  if (store.currentAssistantId) {
    const part = store.parts.find((p) => p.id === store.currentAssistantId);
    if (part && part.kind === 'assistant') part.streaming = false;
  }
  store.currentAssistantId = null;
  if (store.currentThinkingId) {
    const part = store.parts.find((p) => p.id === store.currentThinkingId);
    if (part && part.kind === 'thinking') {
      part.streaming = false;
      part.collapsed = true;
    }
  }
  store.currentThinkingId = null;
}

export function toolInputHint(inputValue: unknown): string {
  if (inputValue == null) return '';
  try {
    const obj =
      typeof inputValue === 'string'
        ? (() => {
            try {
              return JSON.parse(inputValue) as unknown;
            } catch {
              return null;
            }
          })()
        : inputValue;
    if (obj && typeof obj === 'object') {
      const record = obj as Record<string, unknown>;
      const pick =
        record.command ??
        record.path ??
        record.file_path ??
        record.filePath ??
        record.pattern ??
        record.query ??
        record.url ??
        record.prompt ??
        (Array.isArray(record.questions) ? `${record.questions.length} question(s)` : undefined);
      if (typeof pick === 'string' && pick.trim()) {
        const one = pick.trim().replace(/\s+/g, ' ');
        return one.length > 72 ? `${one.slice(0, 72)}…` : one;
      }
    }
    const text = typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue);
    const one = text.trim().replace(/\s+/g, ' ');
    return one.length > 72 ? `${one.slice(0, 72)}…` : one;
  } catch {
    return '';
  }
}

export function summarizeToolInput(inputValue: unknown, max = 900): string {
  if (inputValue == null) return '';
  try {
    const text = typeof inputValue === 'string' ? inputValue : JSON.stringify(inputValue, null, 2);
    return text.length > max ? `${text.slice(0, max)}\n...` : text;
  } catch {
    return String(inputValue);
  }
}

export function parseDiffStats(text: string): { added: number; removed: number } {
  const added = Number(text.match(/\+(\d+)(?:\s*line)?/i)?.[1] || 0);
  const removed = Number(text.match(/(?:^|\s)-(\d+)(?:\s*line)?/im)?.[1] || 0);
  return { added, removed };
}

/** Parse unified-diff style lines into { type, text } rows. */
export function parseDiffLines(text: string): Array<{ type: 'add' | 'del' | 'ctx' | 'meta'; text: string }> {
  const lines = String(text || '').split('\n');
  const rows: Array<{ type: 'add' | 'del' | 'ctx' | 'meta'; text: string }> = [];
  for (const line of lines) {
    if (!line && rows.length === 0) continue;
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ')) {
      rows.push({ type: 'meta', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', text: line.slice(1) });
    } else {
      rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return rows;
}

export function classifyToolFamily(toolName: string): string {
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash' || name === 'powershell') return 'bash';
  if (name === 'edit' || name === 'write' || name === 'notebookedit') return 'edit';
  if (name === 'todowrite' || name === 'todo') return 'todo';
  if (name === 'read') return 'read';
  if (name === 'glob' || name === 'grep') return 'search';
  if (name === 'tavilysearch' || name === 'websearch' || name === 'webfetch') return 'web';
  if (name === 'task' || name === 'agent') return 'task';
  if (name === 'askuserquestion') return 'question';
  return 'generic';
}

export function isReadonlyExploreTool(toolName: string): boolean {
  const family = classifyToolFamily(toolName);
  return family === 'read' || family === 'search';
}

/**
 * Apply a GuiRunEvent to the store. Returns the ids of parts that changed
 * (created or updated) so a view layer can patch DOM selectively.
 */
export function applyGuiEvent(store: TranscriptStore, event: GuiRunEventLike): string[] {
  const changed: string[] = [];
  const type = String(event.type || '');

  if (type === 'user') {
    finalizeStreamingText(store);
    const id = nextId(store, 'user');
    store.parts.push({
      id,
      kind: 'user',
      text: String(event.text ?? ''),
    });
    changed.push(id);
    return changed;
  }

  if (type === 'assistant') {
    finalizeStreamingText(store);
    const id = nextId(store, 'assistant');
    store.parts.push({
      id,
      kind: 'assistant',
      text: String(event.text ?? ''),
      streaming: false,
    });
    changed.push(id);
    return changed;
  }

  if (type === 'delta') {
    const text = String(event.text ?? '');
    if (!text) return changed;
    if (store.currentThinkingId) {
      const thinking = store.parts.find((p) => p.id === store.currentThinkingId);
      if (thinking && thinking.kind === 'thinking') {
        thinking.streaming = false;
        thinking.collapsed = true;
      }
      store.currentThinkingId = null;
    }
    if (!store.currentAssistantId) {
      const id = nextId(store, 'assistant');
      store.parts.push({ id, kind: 'assistant', text: '', streaming: true });
      store.currentAssistantId = id;
      changed.push(id);
    }
    const part = store.parts.find((p) => p.id === store.currentAssistantId);
    if (part && part.kind === 'assistant') {
      part.text += text;
      part.streaming = true;
      changed.push(part.id);
    }
    return changed;
  }

  if (type === 'thinking.delta') {
    const text = String(event.text ?? '');
    const snapshot = typeof event.snapshot === 'string' ? event.snapshot : undefined;
    if (!store.currentThinkingId) {
      finalizeStreamingText(store);
      // finalize clears thinking — recreate
      const id = nextId(store, 'thinking');
      store.parts.push({
        id,
        kind: 'thinking',
        text: snapshot ?? text,
        streaming: true,
        collapsed: false,
      });
      store.currentThinkingId = id;
      changed.push(id);
      return changed;
    }
    const part = store.parts.find((p) => p.id === store.currentThinkingId);
    if (part && part.kind === 'thinking') {
      if (snapshot != null) part.text = snapshot;
      else part.text += text;
      part.streaming = true;
      part.collapsed = false;
      changed.push(part.id);
    }
    return changed;
  }

  if (type === 'tool.call' || type === 'tool') {
    finalizeStreamingText(store);
    const toolUseId = String(event.id ?? event.toolUseId ?? nextId(store, 'tool'));
    const toolName = String(event.name ?? event.toolName ?? 'Tool');
    const existingIdx = store.toolIndex.get(toolUseId);
    if (existingIdx != null && store.parts[existingIdx]?.kind === 'tool') {
      const part = store.parts[existingIdx] as TranscriptToolPart;
      part.toolName = toolName;
      part.state = 'running';
      part.input = event.input ?? part.input;
      part.hint = toolInputHint(part.input);
      part.collapsed = false;
      if (type === 'tool' && event.text != null) {
        part.outputText = String(event.text);
        part.ok = event.ok !== false;
        part.state = part.ok ? 'success' : 'error';
        part.collapsed = true;
        if (typeof event.durationMs === 'number') part.durationMs = event.durationMs;
      }
      changed.push(part.id);
      return changed;
    }
    const id = nextId(store, 'tool');
    const isHistoryComplete = type === 'tool';
    const part: TranscriptToolPart = {
      id,
      kind: 'tool',
      toolName,
      toolUseId,
      state: isHistoryComplete ? (event.ok === false ? 'error' : 'success') : 'running',
      input: event.input,
      outputText: isHistoryComplete ? String(event.text ?? '') : undefined,
      ok: isHistoryComplete ? event.ok !== false : undefined,
      durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
      hint: toolInputHint(event.input),
      collapsed: isHistoryComplete,
    };
    store.toolIndex.set(toolUseId, store.parts.length);
    store.parts.push(part);
    changed.push(id);
    return changed;
  }

  if (type === 'tool.input.delta') {
    const toolUseId = String(event.id ?? `stream-tool-${event.index ?? 'pending'}`);
    let idx = store.toolIndex.get(toolUseId);
    if (idx == null) {
      finalizeStreamingText(store);
      const id = nextId(store, 'tool');
      const part: TranscriptToolPart = {
        id,
        kind: 'tool',
        toolName: String(event.name ?? 'Tool'),
        toolUseId,
        state: 'input-streaming',
        input: { partial_json: event.snapshot ?? event.delta ?? '' },
        hint: 'Building input…',
        collapsed: false,
      };
      store.toolIndex.set(toolUseId, store.parts.length);
      store.parts.push(part);
      changed.push(id);
      return changed;
    }
    const part = store.parts[idx] as TranscriptToolPart;
    part.state = 'input-streaming';
    part.input = { partial_json: event.snapshot ?? event.delta ?? '' };
    part.hint = 'Building input…';
    changed.push(part.id);
    return changed;
  }

  if (type === 'tool.progress') {
    const toolUseId = String(event.id ?? '');
    const idx = store.toolIndex.get(toolUseId);
    if (idx == null) return changed;
    const part = store.parts[idx] as TranscriptToolPart;
    const data = event.data;
    const progress =
      data && typeof data === 'object'
        ? Object.entries(data as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .slice(0, 3)
            .join(' · ')
        : String(data ?? '');
    if (progress) part.hint = progress;
    changed.push(part.id);
    return changed;
  }

  if (type === 'tool.result') {
    const toolUseId = String(event.id ?? '');
    let idx = store.toolIndex.get(toolUseId);
    if (idx == null) {
      // Late result without prior call — synthesize
      applyGuiEvent(store, {
        type: 'tool.call',
        id: toolUseId,
        name: event.name,
        input: event.input,
      });
      idx = store.toolIndex.get(toolUseId);
    }
    if (idx == null) return changed;
    const part = store.parts[idx] as TranscriptToolPart;
    part.ok = event.ok !== false;
    part.state = part.ok ? 'success' : 'error';
    part.outputText = String(event.text ?? '');
    if (typeof event.durationMs === 'number') part.durationMs = event.durationMs;
    if (event.name) part.toolName = String(event.name);
    part.hint = part.hint || toolInputHint(part.input);
    part.collapsed = true;
    changed.push(part.id);
    return changed;
  }

  if (type === 'permission.request') {
    const permissionId = String(event.id ?? '');
    const toolName = String(event.toolName ?? 'Tool');
    // Prefer matching an existing running tool of the same name (most recent)
    let target: TranscriptToolPart | undefined;
    for (let i = store.parts.length - 1; i >= 0; i -= 1) {
      const p = store.parts[i];
      if (p?.kind === 'tool' && p.toolName === toolName && (p.state === 'running' || p.state === 'input-streaming')) {
        target = p;
        break;
      }
    }
    if (!target) {
      finalizeStreamingText(store);
      const toolUseId = String(event.toolUseId ?? nextId(store, 'perm-tool'));
      const id = nextId(store, 'tool');
      target = {
        id,
        kind: 'tool',
        toolName,
        toolUseId,
        state: 'awaiting-approval',
        input: event.input,
        hint: toolInputHint(event.input) || String(event.summary ?? ''),
        collapsed: false,
        permissionId,
        permissionSummary: String(event.summary ?? ''),
      };
      store.toolIndex.set(toolUseId, store.parts.length);
      store.parts.push(target);
      changed.push(id);
    } else {
      const family = classifyToolFamily(toolName);
      target.state = family === 'question' ? 'awaiting-answer' : 'awaiting-approval';
      target.permissionId = permissionId;
      target.permissionSummary = String(event.summary ?? '');
      if (event.input != null) target.input = event.input;
      target.collapsed = false;
      changed.push(target.id);
    }
    return changed;
  }

  if (type === 'notice' || type === 'system') {
    const id = nextId(store, type);
    store.parts.push({
      id,
      kind: type === 'system' ? 'system' : 'notice',
      text: String(event.message ?? event.text ?? ''),
    });
    changed.push(id);
    return changed;
  }

  if (type === 'error') {
    finalizeStreamingText(store);
    const id = nextId(store, 'error');
    store.parts.push({
      id,
      kind: 'error',
      text: String(event.message ?? event.text ?? 'Error'),
    });
    changed.push(id);
    return changed;
  }

  if (type === 'clear') {
    resetTranscriptStore(store);
    return changed;
  }

  if (type === 'done') {
    finalizeStreamingText(store);
    return changed;
  }

  return changed;
}

/** Convert history API entries ({type,text,name,input,ok}) into GuiRunEvents. */
export function historyEntriesToEvents(
  entries: Array<{
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    ok?: boolean;
    id?: string;
    durationMs?: number;
  }>,
): GuiRunEventLike[] {
  const events: GuiRunEventLike[] = [];
  for (const entry of entries) {
    if (entry.type === 'user') {
      events.push({ type: 'user', text: entry.text ?? '' });
    } else if (entry.type === 'assistant') {
      events.push({ type: 'assistant', text: entry.text ?? '' });
    } else if (entry.type === 'tool') {
      events.push({
        type: 'tool',
        id: entry.id ?? `hist-${events.length}`,
        name: entry.name ?? 'Tool',
        input: entry.input,
        ok: entry.ok !== false,
        text: entry.text ?? '',
        durationMs: entry.durationMs,
      });
    } else if (entry.type === 'notice' || entry.type === 'error' || entry.type === 'system') {
      events.push({ type: entry.type, message: entry.text ?? '', text: entry.text ?? '' });
    }
  }
  return events;
}

/** Group consecutive readonly explore tools for ToolGroup UI. */
export function groupExploreTools(parts: TranscriptPart[]): Array<
  | { kind: 'single'; part: TranscriptPart }
  | { kind: 'group'; parts: TranscriptToolPart[]; label: string }
> {
  const out: Array<
    | { kind: 'single'; part: TranscriptPart }
    | { kind: 'group'; parts: TranscriptToolPart[]; label: string }
  > = [];
  let buffer: TranscriptToolPart[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push({ kind: 'single', part: buffer[0]! });
    } else {
      out.push({
        kind: 'group',
        parts: buffer,
        label: `Explored ${buffer.length} files`,
      });
    }
    buffer = [];
  };

  for (const part of parts) {
    if (part.kind === 'tool' && isReadonlyExploreTool(part.toolName) && part.state !== 'running' && part.state !== 'input-streaming') {
      buffer.push(part);
      continue;
    }
    flush();
    out.push({ kind: 'single', part });
  }
  flush();
  return out;
}
