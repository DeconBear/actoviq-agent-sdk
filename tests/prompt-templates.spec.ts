import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_BEHAVIORAL_GUIDELINES_ID,
  BUILTIN_BEHAVIORAL_GUIDELINES_BODY,
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
} from '../src/gui/promptTemplates.js';

describe('promptTemplates', () => {
  let homeDir = '';

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    homeDir = '';
  });

  it('always lists the built-in behavioral guidelines first', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-pt-home-'));
    const templates = await listPromptTemplates(homeDir);
    expect(templates[0]?.id).toBe(BUILTIN_BEHAVIORAL_GUIDELINES_ID);
    expect(templates[0]?.builtin).toBe(true);
    expect(templates[0]?.body).toContain('Think Before Coding');
    expect(templates[0]?.body).toBe(BUILTIN_BEHAVIORAL_GUIDELINES_BODY);
  });

  it('saves user templates for cross-project reuse', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-pt-home-'));
    const created = await createPromptTemplate(homeDir, {
      name: 'My style',
      body: 'Prefer short answers.',
    });
    expect(created.id).toBeTruthy();
    expect(created.builtin).toBeUndefined();

    const templates = await listPromptTemplates(homeDir);
    expect(templates).toHaveLength(2);
    expect(templates[0]?.id).toBe(BUILTIN_BEHAVIORAL_GUIDELINES_ID);
    expect(templates[1]?.name).toBe('My style');
    expect(templates[1]?.body).toBe('Prefer short answers.');
  });

  it('deletes user templates but rejects deleting built-ins', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-pt-home-'));
    const created = await createPromptTemplate(homeDir, {
      name: 'Temp',
      body: 'body',
    });
    await expect(deletePromptTemplate(homeDir, BUILTIN_BEHAVIORAL_GUIDELINES_ID))
      .rejects.toThrow(/Built-in/);
    await expect(deletePromptTemplate(homeDir, created.id)).resolves.toBe(true);
    await expect(deletePromptTemplate(homeDir, created.id)).resolves.toBe(false);
    const templates = await listPromptTemplates(homeDir);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.id).toBe(BUILTIN_BEHAVIORAL_GUIDELINES_ID);
  });
});
