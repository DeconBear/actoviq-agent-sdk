import { describe, expect, it } from 'vitest';

import {
  buildCodewhaleArgs,
  CODEWHALE_READ_ONLY_TOOLS,
  createCodewhaleNormalizer,
} from '../src/parity/codewhaleRuntimeAdapter.js';

describe('buildCodewhaleArgs', () => {
  it('uses exact resume, supported run options, a read-only allowlist, and a prompt boundary', () => {
    const args = buildCodewhaleArgs('--auto', {
      permissionMode: 'default',
      model: 'deepseek-v4-pro',
      maxTurns: 9,
      systemPrompt: 'primary instruction',
      appendSystemPrompt: 'additional instruction',
      tools: ['read_file', 'write_file'],
      allowedTools: ['git_status'],
      disallowedTools: ['exec_shell'],
      resume: 'session_ABC-123',
    });

    expect(args).toEqual([
      'exec',
      '--output-format',
      'stream-json',
      '--allowed-tools',
      'git_status,read_file',
      '--disallowed-tools',
      'exec_shell',
      '--model',
      'deepseek-v4-pro',
      '--max-turns',
      '9',
      '--append-system-prompt',
      'primary instruction\n\nadditional instruction',
      '--resume=session_ABC-123',
      '--',
      '--auto',
    ]);
    expect(args.filter(value => value === '--auto')).toHaveLength(1);
    expect(args.at(-2)).toBe('--');
  });

  it.each(['default', 'plan', 'dontAsk'] as const)(
    'keeps %s runs non-auto and read-only by default',
    permissionMode => {
      const args = buildCodewhaleArgs('inspect the workspace', { permissionMode });

      expect(args).not.toContain('--auto');
      expect(args).toContain('--allowed-tools');
      expect(args[args.indexOf('--allowed-tools') + 1]).toBe(
        CODEWHALE_READ_ONLY_TOOLS.join(','),
      );
    },
  );

  it('only enables CodeWhale auto approval for an explicit bypass', () => {
    const args = buildCodewhaleArgs('make the requested change', {
      permissionMode: 'bypassPermissions',
      allowedTools: ['write_file'],
      disallowedTools: ['exec_shell'],
    });

    expect(args).toContain('--auto');
    expect(args.slice(args.indexOf('--allowed-tools'), args.indexOf('--allowed-tools') + 2))
      .toEqual(['--allowed-tools', 'write_file']);
    expect(args.slice(args.indexOf('--disallowed-tools'), args.indexOf('--disallowed-tools') + 2))
      .toEqual(['--disallowed-tools', 'exec_shell']);
  });

  it('selects the configured provider and lets an explicit model prefix win', () => {
    expect(buildCodewhaleArgs('configured provider', {
      credentialProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
    }).slice(0, 3)).toEqual(['--provider', 'anthropic', 'exec']);

    const prefixed = buildCodewhaleArgs('prefixed provider', {
      credentialProvider: 'anthropic',
      model: 'openrouter/anthropic/claude-sonnet-4-6',
    });
    expect(prefixed.slice(0, 3)).toEqual(['--provider', 'openrouter', 'exec']);
    expect(prefixed.slice(prefixed.indexOf('--model'), prefixed.indexOf('--model') + 2))
      .toEqual(['--model', 'anthropic/claude-sonnet-4-6']);
  });

  it('rejects an option-like provider selector', () => {
    expect(() => buildCodewhaleArgs('unsafe provider', {
      credentialProvider: '--auto',
    })).toThrow(/provider/i);
  });

  it('treats the explicit dangerous compatibility flag as a bypass request', () => {
    expect(buildCodewhaleArgs('run', { dangerouslySkipPermissions: true }))
      .toContain('--auto');
  });

  it('fails closed when acceptEdits cannot be represented safely', () => {
    expect(() => buildCodewhaleArgs('edit', { permissionMode: 'acceptEdits' }))
      .toThrow(/acceptEdits.*not supported.*CodeWhale/i);
  });

  it.each([
    '',
    '--auto',
    '../outside',
    'session\nother',
    'x'.repeat(257),
  ])('rejects unsafe native session id %j', nativeSessionId => {
    expect(() => buildCodewhaleArgs('resume', { resume: nativeSessionId }))
      .toThrow(/session id/i);
  });

  it('uses an explicit session id with resume=true and otherwise uses --continue', () => {
    expect(buildCodewhaleArgs('next', { resume: true, sessionId: 'native_123' }))
      .toContain('--resume=native_123');
    expect(buildCodewhaleArgs('next', { resume: true })).toContain('--continue');
    expect(buildCodewhaleArgs('next', { continueMostRecent: true })).toContain('--continue');
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
    'rejects invalid maxTurns value %s',
    maxTurns => {
      expect(() => buildCodewhaleArgs('run', { maxTurns })).toThrow(/maxTurns/i);
    },
  );
});

describe('createCodewhaleNormalizer', () => {
  it('normalizes deltas, tool lifecycle, metadata, and completion without using the redacted id', () => {
    const normalizer = createCodewhaleNormalizer();

    expect(normalizer.translate({ type: 'content', content: 'hel' })).toEqual([{
      type: 'stream_event',
      session_id: '',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hel' },
      },
    }]);
    expect(normalizer.translate({ type: 'content', content: 'lo' })).toHaveLength(1);

    expect(normalizer.translate({
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'README.md' },
    })).toEqual([{
      type: 'assistant',
      session_id: '',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'README.md' },
        }],
      },
    }]);

    expect(normalizer.translate({
      type: 'tool_result',
      id: 'tool-1',
      output: 'contents',
      status: 'success',
    })).toEqual([{
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'contents',
          is_error: false,
        }],
      },
    }]);

    const correlationHint = '<redacted:0123456789abcdef>';
    expect(normalizer.translate({
      type: 'metadata',
      meta: {
        model: 'deepseek-v4-pro',
        input_tokens: 12,
        output_tokens: 7,
        session_id: correlationHint,
        workspace: 'C:\\workspace',
        message_count: 4,
        status: 'success',
      },
    })).toEqual([{
      type: 'system',
      subtype: 'init',
      session_id: '',
      cwd: 'C:\\workspace',
      model: 'deepseek-v4-pro',
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
      correlationHint,
    }]);
    expect(normalizer.correlationHint).toBe(correlationHint);

    expect(normalizer.translate({ type: 'done' })).toEqual([
      {
        type: 'assistant',
        session_id: '',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: '',
        is_error: false,
        result: 'hello',
        stop_reason: 'end_turn',
        num_turns: 1,
        model: 'deepseek-v4-pro',
        input_tokens: 12,
        output_tokens: 7,
        message_count: 4,
        correlationHint,
      },
    ]);
  });

  it('emits one terminal error result and ignores a later done event', () => {
    const normalizer = createCodewhaleNormalizer();

    expect(normalizer.translate({ type: 'error', error: 'provider failed' })).toEqual([
      {
        type: 'system',
        subtype: 'init',
        session_id: '',
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        agents: [],
        skills: [],
        plugins: [],
      },
      {
        type: 'result',
        subtype: 'error',
        session_id: '',
        is_error: true,
        result: 'provider failed',
        stop_reason: 'error',
        num_turns: 1,
      },
    ]);
    expect(normalizer.translate({ type: 'done' })).toEqual([]);
  });

  it('never promotes an unrecognized metadata session value to a native id', () => {
    const normalizer = createCodewhaleNormalizer();
    const events = normalizer.translate({
      type: 'metadata',
      meta: { session_id: 'actual-native-id-must-not-pass-through' },
    });

    expect(normalizer.correlationHint).toBeUndefined();
    expect(events[0]?.session_id).toBe('');
    expect(events[0]).not.toHaveProperty('correlationHint');
  });

  it('drops malformed or unknown wire events', () => {
    const normalizer = createCodewhaleNormalizer();

    expect(normalizer.translate({ type: 'content', content: 1 })).toEqual([]);
    expect(normalizer.translate({ type: 'tool_use', id: 'x' })).toEqual([]);
    expect(normalizer.translate({ type: 'tool_result', output: 'x' })).toEqual([]);
    expect(normalizer.translate({ type: 'other' })).toEqual([]);
  });
});
