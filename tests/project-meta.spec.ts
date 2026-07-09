import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_STATUS_LABELS,
  PROJECT_STATUSES,
  isProjectStatus,
  projectMetaPath,
  readProjectMeta,
  writeProjectMeta,
} from '../src/gui/projectMeta.js';

describe('projectMeta', () => {
  let homeDir = '';
  let workDir = '';

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
    homeDir = '';
    workDir = '';
  });

  it('exposes five lifecycle statuses with English labels', () => {
    expect(PROJECT_STATUSES).toEqual([
      'in_progress',
      'planning',
      'on_hold',
      'not_started',
      'completed',
    ]);
    expect(PROJECT_STATUS_LABELS.in_progress).toBe('In progress');
    expect(PROJECT_STATUS_LABELS.planning).toBe('Planning');
    expect(PROJECT_STATUS_LABELS.on_hold).toBe('On hold');
    expect(PROJECT_STATUS_LABELS.not_started).toBe('Not started');
    expect(PROJECT_STATUS_LABELS.completed).toBe('Completed');
    expect(isProjectStatus('in_progress')).toBe(true);
    expect(isProjectStatus('active')).toBe(false);
  });

  it('defaults to not_started and persists status updates', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-meta-home-'));
    workDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-meta-work-'));
    const initial = await readProjectMeta(workDir, homeDir);
    expect(initial.status).toBe('not_started');

    const written = await writeProjectMeta(workDir, homeDir, { status: 'planning', issueStorage: 'workspace' });
    expect(written.status).toBe('planning');
    expect(written.issueStorage).toBe('workspace');
    expect(written.updatedAt).toBeTruthy();

    const raw = JSON.parse(await readFile(projectMetaPath(workDir, homeDir), 'utf8'));
    expect(raw.status).toBe('planning');
    expect(raw.issueStorage).toBe('workspace');

    const reread = await readProjectMeta(workDir, homeDir);
    expect(reread.status).toBe('planning');
    expect(reread.issueStorage).toBe('workspace');
  });
});
