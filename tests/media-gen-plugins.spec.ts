import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createImageGenTool } from '../src/plugins/imageGenPlugin.js';
import { createVideoGenTool } from '../src/plugins/videoGenPlugin.js';
import { createMeshGenTool } from '../src/plugins/meshGenPlugin.js';
import {
  MEDIA_GEN_PROVIDER_LINKS,
  selectMediaProfile,
  type MediaGenProfile,
} from '../src/plugins/mediaGenProfiles.js';
import {
  IMAGE_GEN_PROMPT_GUIDANCE,
  VIDEO_GEN_PROMPT_GUIDANCE,
  MESH_GEN_PROMPT_GUIDANCE,
} from '../src/plugins/mediaGenPromptGuidance.js';
import { createManagedPluginRuntime } from '../src/plugins/managedPluginRuntime.js';
import { patchManagedPluginSettings } from '../src/plugins/managedPluginCatalog.js';
import { probeManagedPlugin } from '../src/plugins/managedPluginHealth.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('media gen plugins', () => {
  it('exposes provider API key links for every provider', () => {
    expect(Object.keys(MEDIA_GEN_PROVIDER_LINKS).sort()).toEqual([
      'dashscope',
      'gemini',
      'hailuo',
      'happyhorse',
      'meshy',
      'openai',
      'rodin',
      'seedance',
      'tripo',
    ].sort());
    for (const link of Object.values(MEDIA_GEN_PROVIDER_LINKS)) {
      expect(link.apiKeyUrl).toMatch(/^https:\/\//u);
      expect(link.docsUrl).toMatch(/^https:\/\//u);
    }
  });

  it('injects Qwen-style prompt rewrite guidance into tool prompts', () => {
    const image = createImageGenTool({
      config: {
        profiles: [{
          id: 'gpt',
          provider: 'openai',
          model: 'gpt-image-2',
          apiKey: 'k',
        }],
      },
    });
    const video = createVideoGenTool({
      config: {
        profiles: [{
          id: 'hh',
          provider: 'happyhorse',
          model: 'happyhorse-1.1-t2v',
          apiKey: 'k',
        }],
      },
    });
    const mesh = createMeshGenTool({
      config: {
        profiles: [{
          id: 'meshy',
          provider: 'meshy',
          model: 'latest',
          apiKey: 'k',
        }],
      },
    });
    expect(image.prompt?.({} as never)).toContain('Entity');
    expect(image.prompt?.({} as never)).toContain(IMAGE_GEN_PROMPT_GUIDANCE.slice(0, 40));
    expect(video.prompt?.({} as never)).toContain('Camera');
    expect(video.prompt?.({} as never)).toContain(VIDEO_GEN_PROMPT_GUIDANCE.slice(0, 40));
    expect(mesh.prompt?.({} as never)).toContain('Topology');
    expect(mesh.prompt?.({} as never)).toContain(MESH_GEN_PROMPT_GUIDANCE.slice(0, 40));
  });

  it('selects profiles by id, label, model, or default', () => {
    const profiles: MediaGenProfile[] = [
      {
        id: 'nano-banana',
        label: 'Nano Banana',
        provider: 'gemini',
        model: 'gemini-2.0-flash-preview-image-generation',
        apiKey: 'a',
      },
      {
        id: 'gpt',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'b',
      },
    ];
    expect(selectMediaProfile(profiles, 'nano-banana').id).toBe('nano-banana');
    expect(selectMediaProfile(profiles, 'Nano Banana').id).toBe('nano-banana');
    expect(selectMediaProfile(profiles, 'gpt-image-2').id).toBe('gpt');
    expect(selectMediaProfile(profiles, undefined, 'gpt').id).toBe('gpt');
    expect(selectMediaProfile(profiles, undefined).id).toBe('nano-banana');
  });

  it('generates an OpenAI image and writes it under .hadamard/generated', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'hadamard-image-'));
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/images/generations')) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model: 'gpt-image-2',
            prompt: expect.stringContaining('tabby'),
          });
          return jsonResponse({
            data: [{ b64_json: png.toString('base64') }],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };
      const tool = createImageGenTool({
        cwd,
        fetch: fetchImpl,
        config: {
          profiles: [{
            id: 'gpt',
            provider: 'openai',
            model: 'gpt-image-2',
            apiKey: 'sk-test',
          }],
        },
      });
      const result = await tool.execute({
        prompt: 'A fluffy orange tabby cat on a windowsill, golden hour, 85mm',
        userIntent: '画只猫',
      }, {
        cwd,
        signal: new AbortController().signal,
      } as never);
      expect(result.provider).toBe('openai');
      expect(result.path).toMatch(/\.hadamard\/generated\/images\//u);
      const bytes = await readFile(path.join(cwd, result.path));
      expect(bytes.equals(png)).toBe(true);
      expect(result.userIntent).toBe('画只猫');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('polls Seedance video tasks and downloads the mp4', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'hadamard-video-'));
    try {
      const mp4 = Buffer.from('fake-mp4-bytes');
      let polls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith('/contents/generations/tasks') && !url.includes('task_')) {
          return jsonResponse({ id: 'task_1' });
        }
        if (url.includes('/contents/generations/tasks/task_1')) {
          polls += 1;
          if (polls < 2) return jsonResponse({ status: 'running' });
          return jsonResponse({
            status: 'succeeded',
            content: { video_url: 'https://cdn.example/video.mp4' },
          });
        }
        if (url === 'https://cdn.example/video.mp4') {
          return new Response(mp4, { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };
      const tool = createVideoGenTool({
        cwd,
        fetch: fetchImpl,
        config: {
          pollIntervalMs: 1,
          maxWaitMs: 5_000,
          profiles: [{
            id: 'seedance',
            provider: 'seedance',
            model: 'doubao-seedance-1-5-pro-251215',
            apiKey: 'ark-key',
          }],
        },
      });
      const result = await tool.execute({
        prompt: 'Entity + Scene + Motion + Aesthetic + Stylization: a cat runs through grass, camera pushes in',
      }, {
        cwd,
        signal: new AbortController().signal,
      } as never);
      expect(result.taskId).toBe('task_1');
      expect(result.path).toMatch(/\.hadamard\/generated\/videos\//u);
      expect(await readFile(path.join(cwd, result.path))).toEqual(mp4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs Meshy preview+refine and downloads a GLB', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'hadamard-mesh-'));
    try {
      const glb = Buffer.from('glTF-binary');
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = init?.method || 'GET';
        if (url.endsWith('/openapi/v2/text-to-3d') && method === 'POST') {
          const body = JSON.parse(String(init?.body)) as { mode: string };
          return jsonResponse({ result: body.mode === 'preview' ? 'preview-1' : 'refine-1' });
        }
        if (url.includes('/openapi/v2/text-to-3d/preview-1') || url.includes('/openapi/v2/text-to-3d/refine-1')) {
          return jsonResponse({
            status: 'SUCCEEDED',
            model_urls: { glb: 'https://cdn.example/model.glb' },
          });
        }
        if (url === 'https://cdn.example/model.glb') {
          return new Response(glb, { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };
      const tool = createMeshGenTool({
        cwd,
        fetch: fetchImpl,
        config: {
          pollIntervalMs: 1,
          maxWaitMs: 5_000,
          profiles: [{
            id: 'meshy',
            provider: 'meshy',
            model: 'latest',
            apiKey: 'meshy-key',
          }],
        },
      });
      const result = await tool.execute({
        prompt: 'A lowpoly game-ready wooden chair with PBR oak material',
      }, {
        cwd,
        signal: new AbortController().signal,
      } as never);
      expect(result.path).toMatch(/\.hadamard\/generated\/meshes\//u);
      expect(await readFile(path.join(cwd, result.path))).toEqual(glb);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('mounts generate_* tools from managed plugin runtime', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'image-gen', {
      enabled: true,
      profiles: [{
        id: 'gpt',
        provider: 'openai',
        model: 'gpt-image-2',
        apiKey: 'sk-test',
      }],
    });
    patchManagedPluginSettings(raw, 'video-gen', {
      enabled: true,
      profiles: [{
        id: 'hh',
        provider: 'happyhorse',
        model: 'happyhorse-1.1-t2v',
        apiKey: 'ds-key',
      }],
    });
    patchManagedPluginSettings(raw, 'mesh-gen', {
      enabled: true,
      profiles: [{
        id: 'meshy',
        provider: 'meshy',
        model: 'latest',
        apiKey: 'meshy-key',
      }],
    });
    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    expect(runtime.enabledPluginIds).toEqual(expect.arrayContaining([
      'image-gen',
      'video-gen',
      'mesh-gen',
    ]));
    expect(runtime.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'generate_image',
      'generate_video',
      'generate_mesh',
    ]));
    expect(JSON.stringify(runtime.tools)).not.toContain('sk-test');
    await runtime.close();
  });

  it('health-checks media plugins without calling billable APIs', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'video-gen', {
      enabled: true,
      profiles: [{
        id: 'seedance',
        provider: 'seedance',
        model: 'doubao-seedance-1-5-pro-251215',
        apiKey: 'ark',
      }],
    });
    const health = await probeManagedPlugin(raw, 'video-gen', { cwd: process.cwd() });
    expect(health.state).toBe('ready');
    expect(health.detail).toMatch(/do not call billable/iu);
  });
});
