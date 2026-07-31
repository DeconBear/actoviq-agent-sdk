import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createManagedOcrTool,
  runManagedOcr,
  type ManagedOcrConfig,
} from '../src/plugins/ocrPlugin.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempFile(name: string, contents: Uint8Array): Promise<{
  root: string;
  filePath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ocr-plugin-'));
  tempDirs.push(root);
  const filePath = path.join(root, name);
  await writeFile(filePath, contents);
  return { root, filePath };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('managed OCR plugin', () => {
  it('sends a local image to Qwen chat completions and keeps the API key backend-only', async () => {
    const { root } = await tempFile('receipt.png', new Uint8Array([137, 80, 78, 71]));
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({
        model: 'qwen-vl-ocr-latest',
        choices: [{ message: { content: 'Total: $12.00' } }],
      }));
    const config: ManagedOcrConfig = {
      provider: 'qwen',
      api: 'chat-completions',
      apiKey: 'qwen-secret-key',
      baseUrl: 'https://dashscope.example/compatible-mode/v1/',
      model: 'qwen-vl-ocr-latest',
    };

    const result = await runManagedOcr(
      { source: 'receipt.png', prompt: 'Read the receipt.' },
      config,
      { cwd: root, fetch: fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    expect(requestUrl).toBe('https://dashscope.example/compatible-mode/v1/chat/completions');
    expect(requestInit?.headers).toMatchObject({
      authorization: 'Bearer qwen-secret-key',
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(requestInit?.body)) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'Read the receipt.' },
      {
        type: 'image_url',
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ]);
    expect(result).toEqual({
      provider: 'qwen',
      model: 'qwen-vl-ocr-latest',
      pages: [{ index: 0, text: 'Total: $12.00' }],
    });
    expect(JSON.stringify(result)).not.toContain('qwen-secret-key');
  });

  it('supports OpenAI-compatible Responses image URLs', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({
        model: 'vision-ocr',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Invoice 1042' }],
        }],
      }));

    const result = await runManagedOcr(
      {
        source: 'https://assets.example.test/invoice.webp',
        prompt: 'Extract all text.',
      },
      {
        provider: 'openai-compatible',
        api: 'responses',
        apiKey: 'openai-compatible-secret',
        baseUrl: 'https://vision.example.test/v1',
        model: 'vision-ocr',
      },
      { fetch: fetchImpl },
    );

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    expect(requestUrl).toBe('https://vision.example.test/v1/responses');
    const body = JSON.parse(String(requestInit?.body)) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.input[0]?.content).toEqual([
      { type: 'input_text', text: 'Extract all text.' },
      {
        type: 'input_image',
        image_url: 'https://assets.example.test/invoice.webp',
      },
    ]);
    expect(result).toEqual({
      provider: 'openai-compatible',
      model: 'vision-ocr',
      pages: [{ index: 0, text: 'Invoice 1042' }],
    });
  });

  it('uses input_file for PDFs on the Responses API', async () => {
    const { root } = await tempFile(
      'contract.pdf',
      new TextEncoder().encode('%PDF-1.7\n%%EOF\n'),
    );
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({ model: 'document-ocr', output_text: 'Signed contract' }));

    await runManagedOcr(
      { source: 'contract.pdf' },
      {
        provider: 'openai-compatible',
        api: 'responses',
        apiKey: 'document-secret',
        baseUrl: 'https://documents.example.test/v1',
        model: 'document-ocr',
      },
      { cwd: root, fetch: fetchImpl },
    );

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(body.input[0]?.content[1]).toMatchObject({
      type: 'input_file',
      filename: 'contract.pdf',
      file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
    });
  });

  it('normalizes Mistral /ocr pages for URL documents', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({
        model: 'mistral-ocr-latest',
        pages: [
          { index: 0, markdown: '# First page' },
          { index: 1, markdown: 'Second page' },
        ],
      }));

    const result = await runManagedOcr(
      {
        source: 'https://files.example.test/report.pdf',
        mediaType: 'application/pdf',
      },
      {
        provider: 'mistral',
        apiKey: 'mistral-secret-key',
        baseUrl: 'https://api.mistral.example/v1/',
        model: 'mistral-ocr-latest',
      },
      { fetch: fetchImpl },
    );

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0]!;
    expect(requestUrl).toBe('https://api.mistral.example/v1/ocr');
    const body = JSON.parse(String(requestInit?.body)) as {
      document: Record<string, unknown>;
    };
    expect(body.document).toEqual({
      type: 'document_url',
      document_url: 'https://files.example.test/report.pdf',
    });
    expect(result).toEqual({
      provider: 'mistral',
      model: 'mistral-ocr-latest',
      pages: [
        { index: 0, text: '# First page' },
        { index: 1, text: 'Second page' },
      ],
    });
  });

  it('rejects local payloads above 20 MB before making a provider request', async () => {
    const { root } = await tempFile(
      'too-large.png',
      new Uint8Array(20 * 1024 * 1024 + 1),
    );
    const fetchImpl = vi.fn();

    await expect(runManagedOcr(
      { source: 'too-large.png' },
      {
        provider: 'qwen',
        api: 'chat-completions',
        apiKey: 'secret',
        model: 'qwen-vl-ocr-latest',
      },
      { cwd: root, fetch: fetchImpl },
    )).rejects.toThrow('20 MB');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects absolute and parent-traversal local sources before reading or uploading them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ocr-boundary-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    const outsideFile = path.join(root, 'outside.png');
    await mkdir(workspace);
    await writeFile(outsideFile, new Uint8Array([137, 80, 78, 71]));
    const fetchImpl = vi.fn();
    const config: ManagedOcrConfig = {
      provider: 'qwen',
      apiKey: 'secret',
    };

    await expect(runManagedOcr(
      { source: outsideFile },
      config,
      { cwd: workspace, fetch: fetchImpl },
    )).rejects.toThrow(/workspace-relative/i);
    await expect(runManagedOcr(
      { source: '../outside.png' },
      config,
      { cwd: workspace, fetch: fetchImpl },
    )).rejects.toThrow(/must not contain '\.\.'/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a workspace symlink that resolves to a local file outside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ocr-symlink-'));
    tempDirs.push(root);
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(
      path.join(outside, 'secret.png'),
      new Uint8Array([137, 80, 78, 71]),
    );
    await symlink(
      outside,
      path.join(workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const fetchImpl = vi.fn();

    await expect(runManagedOcr(
      { source: 'escape/secret.png' },
      { provider: 'qwen', apiKey: 'secret' },
      { cwd: workspace, fetch: fetchImpl },
    )).rejects.toThrow(/outside the configured workspace/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not resolve the workspace for HTTP(S) URL sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ocr-url-'));
    tempDirs.push(root);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'qwen-vl-ocr-latest',
        choices: [{ message: { content: 'URL image' } }],
      }));

    await expect(runManagedOcr(
      { source: 'https://assets.example.test/page.png' },
      { provider: 'qwen', apiKey: 'secret' },
      { cwd: path.join(root, 'missing-workspace'), fetch: fetchImpl },
    )).resolves.toMatchObject({
      pages: [{ text: 'URL image' }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports provider failures without echoing a configured secret', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({ error: { message: 'Invalid key: never-return-this-secret' } }, 401));

    await expect(runManagedOcr(
      { source: 'https://assets.example.test/page.png' },
      {
        provider: 'openai-compatible',
        api: 'chat-completions',
        apiKey: 'never-return-this-secret',
        baseUrl: 'https://vision.example.test/v1',
        model: 'vision-ocr',
      },
      { fetch: fetchImpl },
    )).rejects.toThrow('HTTP 401');

    try {
      await runManagedOcr(
        { source: 'https://assets.example.test/page.png' },
        {
          provider: 'openai-compatible',
          api: 'chat-completions',
          apiKey: 'never-return-this-secret',
          baseUrl: 'https://vision.example.test/v1',
          model: 'vision-ocr',
        },
        { fetch: fetchImpl },
      );
    } catch (error) {
      expect((error as Error).message).not.toContain('never-return-this-secret');
    }
  });

  it('creates an agent tool whose input and output never expose the API key', async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      jsonResponse({
        model: 'qwen-vl-ocr-latest',
        choices: [{ message: { content: 'Recognized' } }],
      }));
    const tool = createManagedOcrTool(
      {
        provider: 'qwen',
        api: 'chat-completions',
        apiKey: 'tool-secret-key',
        baseUrl: 'https://dashscope.example/v1',
        model: 'qwen-vl-ocr-latest',
      },
      { fetch: fetchImpl },
    );

    expect(tool.name).toBe('OCR');
    expect(JSON.stringify(tool.inputJsonSchema)).not.toMatch(/api.?key/i);
    expect(tool.isReadOnly?.({ source: 'https://assets.example.test/page.png' })).toBe(true);
    expect(tool.isDestructive?.({ source: 'https://assets.example.test/page.png' })).toBe(false);
    expect(tool.requiresUserInteraction?.()).toBe(true);
    const result = await tool.execute(
      { source: 'https://assets.example.test/page.png' },
      {
        runId: 'run-1',
        cwd: process.cwd(),
        metadata: {},
        prompt: 'Read it',
        iteration: 0,
      },
    );
    expect(result).toEqual({
      provider: 'qwen',
      model: 'qwen-vl-ocr-latest',
      pages: [{ index: 0, text: 'Recognized' }],
    });
    expect(JSON.stringify(result)).not.toContain('tool-secret-key');
  });
});
