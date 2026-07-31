import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseReasonixSessionJsonl,
  resolveReasonixSessionRoots,
} from '../src/parity/reasonixSessionParser.js';

describe('parseReasonixSessionJsonl', () => {
  it('parses current provider-message checkpoints with ACP metadata', () => {
    const parsed = parseReasonixSessionJsonl([
      { role: 'system', content: 'System instructions' },
      {
        role: 'user',
        content: 'Inspect the graph',
        timestamp: '2026-07-14T01:01:00.000Z',
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'I should inspect the files first.',
        tool_calls: [{
          id: 'tool-1',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        }],
      },
      {
        role: 'tool',
        content: 'README contents',
        tool_call_id: 'tool-1',
        name: 'read_file',
      },
      { role: 'assistant', content: 'The graph is valid.' },
    ], {
      filePath: path.join('sessions', '8e85dc1d-8254-4f89-a9d8-99bd19708a64.jsonl'),
      metadata: JSON.stringify({
        sessionId: '8e85dc1d-8254-4f89-a9d8-99bd19708a64',
        cwd: 'C:\\workspace',
        model: 'deepseek/deepseek-v4',
        title: 'Graph inspection',
        createdAt: '2026-07-14T01:00:00.000Z',
        updatedAt: '2026-07-14T01:05:00.000Z',
        activeTranscript: 'recovered-session.jsonl',
      }),
    });

    expect(parsed).toMatchObject({
      nativeSessionId: '8e85dc1d-8254-4f89-a9d8-99bd19708a64',
      title: 'Graph inspection',
      cwd: 'C:\\workspace',
      model: 'deepseek/deepseek-v4',
      createdAt: '2026-07-14T01:00:00.000Z',
      updatedAt: '2026-07-14T01:05:00.000Z',
      activeTranscript: 'recovered-session.jsonl',
      recordsScanned: 5,
      messageCount: 6,
      truncated: false,
    });
    expect(parsed.messages).toEqual([
      {
        role: 'system',
        text: 'System instructions',
        model: 'deepseek/deepseek-v4',
      },
      {
        role: 'user',
        text: 'Inspect the graph',
        timestamp: '2026-07-14T01:01:00.000Z',
        model: 'deepseek/deepseek-v4',
      },
      {
        role: 'think',
        text: 'I should inspect the files first.',
        model: 'deepseek/deepseek-v4',
      },
      {
        role: 'assistant',
        text: '',
        model: 'deepseek/deepseek-v4',
        tools: [{
          kind: 'call',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        text: 'README contents',
        model: 'deepseek/deepseek-v4',
        tools: [{
          kind: 'result',
          id: 'tool-1',
          name: 'read_file',
          output: 'README contents',
        }],
      },
      {
        role: 'assistant',
        text: 'The graph is valid.',
        model: 'deepseek/deepseek-v4',
      },
    ]);
  });

  it('parses legacy ChatMessage JSONL and legacy sidecar fields', () => {
    const jsonl = [
      '{not-json}',
      JSON.stringify({
        role: 'user',
        content: 'Legacy question',
        timestamp: 1_721_000_000,
      }),
      JSON.stringify({
        role: 'assistant',
        content: null,
        reasoning_content: 'Legacy reasoning',
        tool_calls: [{
          id: 'legacy-tool',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command":"pwd"}',
          },
        }],
      }),
      JSON.stringify({
        role: 'tool',
        content: 'command failed',
        tool_call_id: 'legacy-tool',
        name: 'bash',
        is_error: true,
      }),
      '',
    ].join('\r\n');

    const parsed = parseReasonixSessionJsonl(jsonl, {
      filePath: path.join('sessions', 'legacy-session.jsonl'),
      metadata: {
        summary: '  Legacy   title  ',
        workspace: '/old/workspace',
        model: 'deepseek-chat',
      },
      fileCreatedAt: '2024-07-13T00:00:00.000Z',
      fileUpdatedAt: '2024-07-13T00:10:00.000Z',
    });

    expect(parsed).toMatchObject({
      nativeSessionId: 'legacy-session',
      title: 'Legacy title',
      cwd: '/old/workspace',
      model: 'deepseek-chat',
      createdAt: '2024-07-13T00:00:00.000Z',
      updatedAt: '2024-07-14T23:33:20.000Z',
      recordsScanned: 4,
      messageCount: 4,
      truncated: false,
    });
    expect(parsed.messages[0]).toMatchObject({
      role: 'user',
      text: 'Legacy question',
      timestamp: '2024-07-14T23:33:20.000Z',
    });
    expect(parsed.messages[1]).toMatchObject({
      role: 'think',
      text: 'Legacy reasoning',
    });
    expect(parsed.messages[2]).toMatchObject({
      role: 'assistant',
      tools: [{
        kind: 'call',
        id: 'legacy-tool',
        name: 'bash',
        input: { command: 'pwd' },
      }],
    });
    expect(parsed.messages[3]).toMatchObject({
      role: 'tool',
      text: 'command failed',
      tools: [{
        kind: 'result',
        id: 'legacy-tool',
        name: 'bash',
        output: 'command failed',
        isError: true,
      }],
    });
  });

  it('uses bounded record, message, text, and tool-payload state', () => {
    const parsed = parseReasonixSessionJsonl([
      { role: 'user', content: '1234567890' },
      { role: 'assistant', content: 'abcdefghij' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'tool-1',
          name: 'large_tool',
          arguments: JSON.stringify({ value: 'x'.repeat(200) }),
        }],
      },
      { role: 'user', content: 'fourth' },
      { role: 'assistant', content: 'not scanned' },
    ], {
      maxRecords: 4,
      maxMessages: 2,
      maxTextChars: 12,
      maxToolPayloadChars: 16,
    });

    expect(parsed).toMatchObject({
      title: '1234567890',
      recordsScanned: 4,
      messageCount: 4,
      truncated: true,
    });
    expect(parsed.messages).toEqual([
      { role: 'user', text: '1234567890' },
      { role: 'assistant', text: 'ab' },
    ]);
  });

  it('ignores corrupt metadata and unsafe active-transcript redirects', () => {
    expect(parseReasonixSessionJsonl(
      [JSON.stringify({ role: 'user', content: 'Fallback title' })],
      { metadata: '{broken', filePath: 'fallback.jsonl' },
    )).toMatchObject({
      nativeSessionId: 'fallback',
      title: 'Fallback title',
    });

    expect(parseReasonixSessionJsonl([], {
      metadata: {
        sessionId: 'safe-id',
        activeTranscript: '..\\outside.jsonl',
      },
    }).activeTranscript).toBeUndefined();
  });

  it('marks oversized input records as truncated without parsing them', () => {
    const parsed = parseReasonixSessionJsonl([
      JSON.stringify({ role: 'user', content: 'x'.repeat(200) }),
      JSON.stringify({ role: 'assistant', content: 'kept' }),
    ], { maxRecordChars: 80 });
    expect(parsed).toMatchObject({
      recordsScanned: 2,
      messageCount: 1,
      truncated: true,
    });
    expect(parsed.messages).toEqual([{ role: 'assistant', text: 'kept' }]);
  });
});

describe('resolveReasonixSessionRoots', () => {
  it('uses the legacy-compatible Unix home root when no override exists', () => {
    const home = path.join(path.parse(process.cwd()).root, 'users', 'reasonix-test');
    expect(resolveReasonixSessionRoots(home, {})).toEqual([
      path.join(home, '.reasonix', 'sessions'),
    ]);
  });

  it('returns current Windows AppData and legacy home roots without duplicates', () => {
    const root = path.parse(process.cwd()).root;
    const home = path.join(root, 'Users', 'reasonix-test');
    const appData = path.join(home, 'AppData', 'Roaming');
    expect(resolveReasonixSessionRoots(home, { APPDATA: appData })).toEqual([
      path.join(appData, 'reasonix', 'sessions'),
      path.join(home, '.reasonix', 'sessions'),
    ]);
  });

  it('expands isolated home and state overrides without consulting process env', () => {
    const root = path.parse(process.cwd()).root;
    const home = path.join(root, 'users', 'reasonix-test');
    const state = path.join(root, 'state', 'reasonix-test');
    expect(resolveReasonixSessionRoots(home, {
      REASONIX_HOME: '~/isolated-reasonix',
      REASONIX_STATE_HOME: '$HADAMARD_REASONIX_STATE',
      HADAMARD_REASONIX_STATE: state,
      APPDATA: path.join(root, 'ignored-appdata'),
    })).toEqual([
      path.join(state, 'sessions'),
      path.join(home, 'isolated-reasonix', 'sessions'),
    ]);
  });

  it('requires an explicit home input', () => {
    expect(() => resolveReasonixSessionRoots(' ', {})).toThrow('homeDir is required.');
  });
});
