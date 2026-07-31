import { describe, expect, it } from 'vitest';

import {
  applyGuiEvent,
  classifyToolFamily,
  createTranscriptStore,
  groupExploreTools,
  historyEntriesToEvents,
  parseDiffLines,
  parseDiffStats,
  resetTranscriptStore,
  toolInputHint,
} from '../src/gui/transcript/parts.js';
import { getTranscriptClientScript } from '../src/gui/transcript/clientBundle.js';
import { getTranscriptStyles } from '../src/gui/transcript/styles.js';

describe('transcript parts reducer', () => {
  it('streams assistant text and finalizes on tool.call', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'user', text: 'hi' });
    applyGuiEvent(store, { type: 'delta', text: 'Hello' });
    applyGuiEvent(store, { type: 'delta', text: ' world' });
    expect(store.parts).toHaveLength(2);
    expect(store.parts[1]).toMatchObject({ kind: 'assistant', text: 'Hello world', streaming: true });

    applyGuiEvent(store, { type: 'tool.call', id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(store.parts[1]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(store.parts[2]).toMatchObject({
      kind: 'tool',
      toolName: 'Bash',
      toolUseId: 't1',
      state: 'running',
      hint: 'ls',
    });
  });

  it('updates tool results and collapses on success', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'tool.call', id: 't1', name: 'Read', input: { file_path: 'a.ts' } });
    applyGuiEvent(store, { type: 'tool.result', id: 't1', name: 'Read', ok: true, text: 'contents', durationMs: 12 });
    const tool = store.parts[0];
    expect(tool).toMatchObject({
      kind: 'tool',
      state: 'success',
      ok: true,
      outputText: 'contents',
      collapsed: true,
      durationMs: 12,
    });
  });

  it('renders thinking deltas as a collapsible thinking part', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'thinking.delta', text: 'step 1' });
    applyGuiEvent(store, { type: 'thinking.delta', text: ' step 2' });
    expect(store.parts[0]).toMatchObject({
      kind: 'thinking',
      text: 'step 1 step 2',
      streaming: true,
      collapsed: false,
    });
    applyGuiEvent(store, { type: 'delta', text: 'answer' });
    expect(store.parts[0]).toMatchObject({ kind: 'thinking', collapsed: true, streaming: false });
    expect(store.parts[1]).toMatchObject({ kind: 'assistant', text: 'answer' });
  });

  it('attaches permission.request to the latest matching tool', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, {
      type: 'tool.call',
      id: 't1',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick?', header: 'Mode', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] },
    });
    applyGuiEvent(store, {
      type: 'permission.request',
      id: 'perm-1',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Pick?', header: 'Mode', options: [] }] },
      summary: 'questions',
    });
    expect(store.parts[0]).toMatchObject({
      kind: 'tool',
      state: 'awaiting-answer',
      permissionId: 'perm-1',
    });
  });

  it('hydrates history entries through the same event shapes', () => {
    const events = historyEntriesToEvents([
      { type: 'user', text: 'go' },
      { type: 'assistant', text: 'ok' },
      { type: 'tool', id: 't1', name: 'Edit', input: { file_path: 'x.ts' }, ok: true, text: '+1\\n-1' },
    ]);
    const store = createTranscriptStore();
    for (const event of events) applyGuiEvent(store, event);
    expect(store.parts.map((p) => p.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(store.parts[2]).toMatchObject({ toolName: 'Edit', state: 'success', toolUseId: 't1' });
  });

  it('groups consecutive readonly explore tools', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'tool', id: 'a', name: 'Read', input: { file_path: 'a' }, ok: true, text: '1' });
    applyGuiEvent(store, { type: 'tool', id: 'b', name: 'Grep', input: { pattern: 'x' }, ok: true, text: '2' });
    applyGuiEvent(store, { type: 'tool', id: 'c', name: 'Bash', input: { command: 'ls' }, ok: true, text: '3' });
    const grouped = groupExploreTools(store.parts);
    expect(grouped[0]).toMatchObject({ kind: 'group', label: 'Explored 2 files' });
    expect(grouped[1]).toMatchObject({ kind: 'single' });
  });

  it('resets the store on clear', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'user', text: 'x' });
    applyGuiEvent(store, { type: 'clear' });
    expect(store.parts).toEqual([]);
    expect(store.toolIndex.size).toBe(0);
    resetTranscriptStore(store);
    expect(store.seq).toBe(0);
  });
});

describe('transcript helpers', () => {
  it('classifies tool families', () => {
    expect(classifyToolFamily('Bash')).toBe('bash');
    expect(classifyToolFamily('Write')).toBe('edit');
    expect(classifyToolFamily('TodoWrite')).toBe('todo');
    expect(classifyToolFamily('AskUserQuestion')).toBe('question');
  });

  it('extracts hints and diff stats', () => {
    expect(toolInputHint({ command: 'npm test' })).toBe('npm test');
    expect(parseDiffStats('+3 lines -1 line')).toEqual({ added: 3, removed: 1 });
    expect(parseDiffLines('-old\n+new').map((r) => r.type)).toEqual(['del', 'add']);
  });

  it('ships client bundle and styles', () => {
    const script = getTranscriptClientScript();
    const styles = getTranscriptStyles();
    expect(script).toContain('__HadamardTranscript');
    expect(script).toContain('tool-bash-body');
    expect(script).toContain('awaiting-answer');
    expect(styles).toContain('.thinking-card');
    expect(styles).toContain('.transcript-jump');
  });

  it('discards partial text and tool input when a response stream retries', () => {
    const store = createTranscriptStore();
    applyGuiEvent(store, { type: 'user', text: 'go' });
    applyGuiEvent(store, { type: 'delta', text: 'incorrect prefix' });
    applyGuiEvent(store, { type: 'tool.input.delta', id: 'partial-tool', name: 'Bash', delta: '{"command":' });

    applyGuiEvent(store, { type: 'response.retry' });

    expect(store.parts).toHaveLength(1);
    expect(store.parts[0]).toMatchObject({ kind: 'user', text: 'go' });
    expect(store.toolIndex.size).toBe(0);
    applyGuiEvent(store, { type: 'delta', text: 'correct result' });
    expect(store.parts[1]).toMatchObject({ kind: 'assistant', text: 'correct result' });
  });

  it('patches mounted tool cards without replacing their DOM node', () => {
    const script = getTranscriptClientScript();
    const renderPart = script.slice(
      script.indexOf('function renderPart(part)'),
      script.indexOf('function hydrate(entries)'),
    );
    const patchToolCard = script.slice(
      script.indexOf('function patchToolCard(card, part)'),
      script.indexOf('function buildToolCard(part)'),
    );

    expect(renderPart).toContain("part.kind === 'tool'");
    expect(renderPart).toContain('patchToolCard(node, part);');
    expect(renderPart).toMatch(/patchToolCard\(node, part\);\s+TR\.nodes\.set\(part\.id, node\);\s+return;/);
    expect(renderPart.indexOf('patchToolCard(node, part);')).toBeLessThan(renderPart.indexOf('node.replaceWith(fresh);'));
    expect(patchToolCard).toContain("header.querySelector('.tool-toggle')");
    expect(patchToolCard).toContain('updateToolBody(body, part, family);');
    expect(patchToolCard).toContain('syncToolFooters(card, part);');
  });
});

describe('transcript scroll helpers', () => {
  it('tracks stick-to-bottom and jump visibility', async () => {
    const { createStickToBottomState, shouldShowJumpButton, updateStickFromScroll } = await import(
      '../src/gui/transcript/scroll.js'
    );
    const state = createStickToBottomState(80);
    expect(updateStickFromScroll(state, 0, 1000, 400)).toBe(false);
    expect(shouldShowJumpButton(state, 1000, 400)).toBe(true);
    expect(updateStickFromScroll(state, 580, 1000, 400)).toBe(true);
    expect(shouldShowJumpButton(state, 1000, 400)).toBe(false);
  });
});
