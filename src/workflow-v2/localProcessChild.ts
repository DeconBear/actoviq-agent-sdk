/**
 * The function is stringified and launched with `node --eval`. It must remain
 * self-contained: no references to module-scope values or imports.
 */
async function isolatedWorkflowChildMain(): Promise<void> {
  const vm = process.getBuiltinModule('node:vm') as typeof import('node:vm');
  const readline = process.getBuiltinModule('node:readline') as typeof import('node:readline');

  type RpcId = string | number;
  interface RpcMessage {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }
  interface ExecuteParams {
    source: string;
    input: unknown;
    capabilities: string[];
    vmTimeoutMs: number;
    maxOutputBytes: number;
    maxMessageBytes: number;
    maxProtocolMessages: number;
  }

  const hardMaxMessageBytes = 16 * 1_024 * 1_024;
  let maxMessageBytes = hardMaxMessageBytes;
  let maxProtocolMessages = 1_024;
  let sentMessages = 0;
  let receivedMessages = 0;
  let nextCapabilityId = 1;
  let executeStarted = false;
  let closing = false;
  const pendingCapabilities = new Map<
    RpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8');
  }

  function protocolError(message: string, code = 'WORKFLOW_PROTOCOL_ERROR'): Error {
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    return error;
  }

  function send(message: RpcMessage): void {
    sentMessages += 1;
    if (sentMessages + receivedMessages > maxProtocolMessages) {
      throw protocolError(
        'Workflow exceeded its protocol message count.',
        'WORKFLOW_MESSAGE_LIMIT_EXCEEDED',
      );
    }
    const json = JSON.stringify(message);
    if (byteLength(json) > maxMessageBytes) {
      throw protocolError(
        'Workflow protocol message exceeded its byte limit.',
        'WORKFLOW_MESSAGE_LIMIT_EXCEEDED',
      );
    }
    process.stdout.write(`${json}\n`);
  }

  function sanitizeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 2_048);
  }

  function errorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'WORKFLOW_TIMEOUT';
      if (code.startsWith('WORKFLOW_')) return code;
    }
    return 'WORKFLOW_EXECUTION_FAILED';
  }

  function closeAfterResponse(): void {
    if (closing) return;
    closing = true;
    setImmediate(() => {
      for (const pending of pendingCapabilities.values()) {
        pending.reject(protocolError('Workflow child closed before capability response.'));
      }
      pendingCapabilities.clear();
      input.close();
      process.stdin.pause();
    });
  }

  function safeJsonStringify(value: unknown): string {
    const json = JSON.stringify(value === undefined ? null : value);
    if (typeof json !== 'string') {
      throw protocolError(
        'Workflow value must be JSON serializable.',
        'WORKFLOW_EXECUTION_FAILED',
      );
    }
    if (byteLength(json) > maxMessageBytes) {
      throw protocolError(
        'Workflow capability value exceeded its message limit.',
        'WORKFLOW_MESSAGE_LIMIT_EXCEEDED',
      );
    }
    return json;
  }

  async function callCapability(name: string, inputJson: string): Promise<string> {
    if (typeof inputJson !== 'string' || byteLength(inputJson) > maxMessageBytes) {
      throw protocolError(
        'Workflow capability input exceeded its message limit.',
        'WORKFLOW_MESSAGE_LIMIT_EXCEEDED',
      );
    }
    const value = JSON.parse(inputJson) as unknown;
    const id = `capability:${nextCapabilityId++}`;
    const result = await new Promise<unknown>((resolve, reject) => {
      pendingCapabilities.set(id, { resolve, reject });
      try {
        send({
          jsonrpc: '2.0',
          id,
          method: 'capability.call',
          params: { name, input: value },
        });
      } catch (error) {
        pendingCapabilities.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return safeJsonStringify(result);
  }

  function validateExecuteParams(value: unknown): ExecuteParams {
    if (!value || typeof value !== 'object') {
      throw protocolError('workflow.execute params must be an object.');
    }
    const params = value as Partial<ExecuteParams>;
    if (typeof params.source !== 'string' || params.source.trim().length === 0) {
      throw protocolError('Workflow source must be a non-empty string.');
    }
    if (!Array.isArray(params.capabilities)
      || !params.capabilities.every(name => typeof name === 'string')) {
      throw protocolError('Workflow capabilities must be a string array.');
    }
    for (const field of [
      'vmTimeoutMs',
      'maxOutputBytes',
      'maxMessageBytes',
      'maxProtocolMessages',
    ] as const) {
      if (!Number.isSafeInteger(params[field]) || Number(params[field]) <= 0) {
        throw protocolError(`${field} must be a positive safe integer.`);
      }
    }
    if (Number(params.maxMessageBytes) > hardMaxMessageBytes) {
      throw protocolError('maxMessageBytes exceeds the hard child limit.');
    }
    return params as ExecuteParams;
  }

  async function execute(paramsValue: unknown): Promise<unknown> {
    const params = validateExecuteParams(paramsValue);
    maxMessageBytes = params.maxMessageBytes;
    maxProtocolMessages = params.maxProtocolMessages;

    const contextObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(contextObject, {
      __actoviqInputJson: {
        value: safeJsonStringify(params.input),
        configurable: true,
        writable: false,
      },
      __actoviqCapabilityNamesJson: {
        value: safeJsonStringify(params.capabilities),
        configurable: true,
        writable: false,
      },
      __actoviqHostCapabilityCall: {
        value: callCapability,
        configurable: true,
        writable: false,
      },
    });
    const context = vm.createContext(contextObject, {
      name: 'actoviq-local-isolated-workflow',
      codeGeneration: { strings: false, wasm: false },
    });
    const nativeWorkflowContext = new vm.Script([
      '(() => {',
      '  const __hostCall = globalThis.__actoviqHostCapabilityCall;',
      '  const __capabilityNames = JSON.parse(globalThis.__actoviqCapabilityNamesJson);',
      '  const __capabilities = Object.create(null);',
      '  for (const __name of __capabilityNames) {',
      '    Object.defineProperty(__capabilities, __name, {',
      '      enumerable: true,',
      '      configurable: false,',
      '      writable: false,',
      '      value: async (__input = null) => {',
      '        const __inputJson = JSON.stringify(__input);',
      '        const __outputJson = await __hostCall(__name, __inputJson);',
      '        return JSON.parse(__outputJson);',
      '      },',
      '    });',
      '  }',
      '  return Object.freeze({',
      '    input: JSON.parse(globalThis.__actoviqInputJson),',
      '    capabilities: Object.freeze(__capabilities),',
      '  });',
      '})()',
    ].join('\n'), {
      filename: 'isolated-workflow-context.js',
    }).runInContext(context, { timeout: params.vmTimeoutMs });
    delete contextObject.__actoviqInputJson;
    delete contextObject.__actoviqCapabilityNamesJson;
    delete contextObject.__actoviqHostCapabilityCall;
    Object.defineProperty(contextObject, '__actoviqContext', {
      value: nativeWorkflowContext,
      configurable: false,
      writable: false,
    });
    const program = new vm.Script([
      '"use strict";',
      `const __actoviqProgram = (${params.source});`,
      'if (typeof __actoviqProgram !== "function") {',
      '  throw new TypeError("Workflow source must evaluate to a function.");',
      '}',
      'Promise.resolve(__actoviqProgram(globalThis.__actoviqContext));',
    ].join('\n'), {
      filename: 'isolated-workflow.js',
    });
    const pendingResult = program.runInContext(context, {
      timeout: params.vmTimeoutMs,
    }) as PromiseLike<unknown>;
    const rawResult = await pendingResult;

    Object.defineProperty(contextObject, '__actoviqResult', {
      value: rawResult,
      configurable: true,
    });
    let serialized: unknown;
    try {
      serialized = new vm.Script(
        'JSON.stringify(globalThis.__actoviqResult)',
        { filename: 'isolated-workflow-output.js' },
      ).runInContext(context, { timeout: params.vmTimeoutMs });
    } finally {
      delete contextObject.__actoviqResult;
    }
    if (typeof serialized !== 'string') {
      throw protocolError(
        'Workflow output must be a JSON value.',
        'WORKFLOW_EXECUTION_FAILED',
      );
    }
    if (byteLength(serialized) > params.maxOutputBytes) {
      throw protocolError(
        'Workflow output exceeded its byte limit.',
        'WORKFLOW_OUTPUT_LIMIT_EXCEEDED',
      );
    }
    return JSON.parse(serialized);
  }

  async function handleMessage(message: RpcMessage): Promise<void> {
    if (message.jsonrpc !== '2.0') {
      throw protocolError('Workflow child requires JSON-RPC 2.0 messages.');
    }
    if (message.method === 'workflow.execute') {
      if (executeStarted) {
        throw protocolError('Workflow child accepts exactly one execute request.');
      }
      executeStarted = true;
      const id = message.id as RpcId;
      try {
        const result = await execute(message.params);
        send({ jsonrpc: '2.0', id, result });
      } catch (error) {
        try {
          send({
            jsonrpc: '2.0',
            id,
            error: {
              code: errorCode(error),
              message: sanitizeMessage(error),
            },
          });
        } catch (sendError) {
          process.stderr.write(sanitizeMessage(sendError));
          process.exitCode = 1;
        }
      } finally {
        closeAfterResponse();
      }
      return;
    }

    const id = message.id as RpcId;
    const pending = pendingCapabilities.get(id);
    if (!pending) {
      throw protocolError(`Unexpected JSON-RPC response id: ${String(id)}.`);
    }
    pendingCapabilities.delete(id);
    if (message.error !== undefined) {
      const remote = message.error as { code?: unknown; message?: unknown };
      pending.reject(protocolError(
        typeof remote.message === 'string' ? remote.message : 'Capability call failed.',
        typeof remote.code === 'string' ? remote.code : 'WORKFLOW_CAPABILITY_FAILED',
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  input.on('line', line => {
    if (closing) return;
    if (byteLength(line) > maxMessageBytes) {
      process.stderr.write('Workflow input message exceeded its byte limit.');
      process.exitCode = 1;
      closeAfterResponse();
      return;
    }
    receivedMessages += 1;
    if (receivedMessages + sentMessages > maxProtocolMessages) {
      process.stderr.write('Workflow input exceeded its protocol message count.');
      process.exitCode = 1;
      closeAfterResponse();
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      process.stderr.write('Workflow child received invalid JSON.');
      process.exitCode = 1;
      closeAfterResponse();
      return;
    }
    void handleMessage(message).catch(error => {
      process.stderr.write(sanitizeMessage(error));
      process.exitCode = 1;
      closeAfterResponse();
    });
  });
}

export function createLocalProcessChildSource(): string {
  return `void (${isolatedWorkflowChildMain.toString()})();`;
}
