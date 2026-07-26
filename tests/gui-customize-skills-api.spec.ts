import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startActoviqGuiServer } from '../src/gui/actoviqGui.js';
import { resolveActoviqHome } from '../src/config/actoviqHome.js';
import { readActoviqExternalSkillPreferences } from '../src/runtime/externalSkillPreferences.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function api<T>(
  server: Awaited<ReturnType<typeof startActoviqGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(requestPath.replace(/^\/+/, ''), server.url), {
    ...init,
    headers: { 'x-actoviq-token': server.token, ...init.headers },
  });
  return { status: response.status, body: await response.json() as T };
}

describe('GUI Customize skills API', () => {
  it('trusts, loads, and disables a project runtime skill without editing its source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-customize-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const skillFile = path.join(workDir, '.codex', 'skills', 'project-review', 'SKILL.md');
    const siblingSkillFile = path.join(workDir, '.codex', 'skills', 'project-format', 'SKILL.md');
    const skillText = [
      '---',
      'name: project-review',
      'description: Review project changes',
      'allowed-tools: Bash, Write',
      '---',
      '',
      'Review the current project carefully.',
      '',
    ].join('\n');
    const siblingSkillText = [
      '---',
      'name: project-format',
      'description: Format project changes',
      '---',
      '',
      'Format the current project carefully.',
      '',
    ].join('\n');
    await Promise.all([
      mkdir(path.dirname(skillFile), { recursive: true }),
      mkdir(path.dirname(siblingSkillFile), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(skillFile, skillText, 'utf8'),
      writeFile(siblingSkillFile, siblingSkillText, 'utf8'),
    ]);

    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      type Snapshot = {
        catalog: {
          sources: Array<{ id: string; status: string; needsTrust: boolean }>;
          skills: Array<{ id: string; name: string; status: string }>;
        };
        preferences: { disabledSourceIds: string[]; disabledSkillIds: string[]; trustedProjectSourceIds: string[] };
        activeSkillIds: string[];
      };
      const initial = await api<Snapshot>(server, '/api/customize/skills');
      expect(initial.status).toBe(200);
      expect(initial.body.catalog.sources.find(source => source.id === 'codex:project')).toMatchObject({
        status: 'needs-trust',
        needsTrust: true,
      });
      const skill = initial.body.catalog.skills.find(item => item.name === 'project-review');
      const siblingSkill = initial.body.catalog.skills.find(item => item.name === 'project-format');
      expect(skill).toBeTruthy();
      expect(siblingSkill).toBeTruthy();
      expect(initial.body.activeSkillIds).not.toContain(skill!.id);

      const trusted = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'codex:project', enabled: true, trust: true }),
      });
      expect(trusted.status).toBe(200);
      expect(trusted.body.preferences.trustedProjectSourceIds).toContain('codex:project');
      expect(trusted.body.activeSkillIds).toContain(skill!.id);
      expect(trusted.body.activeSkillIds).toContain(siblingSkill!.id);

      const skillDisabled = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'skill', skillId: skill!.id, enabled: false }),
      });
      expect(skillDisabled.status).toBe(200);
      expect(skillDisabled.body.preferences.disabledSkillIds).toContain(skill!.id);
      expect(skillDisabled.body.activeSkillIds).not.toContain(skill!.id);
      expect(skillDisabled.body.activeSkillIds).toContain(siblingSkill!.id);

      const skillEnabled = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'skill', skillId: skill!.id, enabled: true }),
      });
      expect(skillEnabled.status).toBe(200);
      expect(skillEnabled.body.preferences.disabledSkillIds).not.toContain(skill!.id);
      expect(skillEnabled.body.activeSkillIds).toContain(skill!.id);

      const disabled = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'codex:project', enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.preferences.disabledSourceIds).toContain('codex:project');
      expect(disabled.body.activeSkillIds).not.toContain(skill!.id);
      expect(disabled.body.activeSkillIds).not.toContain(siblingSkill!.id);
      expect(await readFile(skillFile, 'utf8')).toBe(skillText);
      expect(await readFile(siblingSkillFile, 'utf8')).toBe(siblingSkillText);
      expect((await readActoviqExternalSkillPreferences({ actoviqHomeDir: resolveActoviqHome(homeDir), workDir })).disabledSourceIds)
        .toContain('codex:project');

      const revoked = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'codex:project', enabled: false, trust: false }),
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.preferences.trustedProjectSourceIds).not.toContain('codex:project');
      expect(revoked.body.preferences.disabledSourceIds).toContain('codex:project');
      expect(revoked.body.activeSkillIds).not.toContain(skill!.id);
    } finally {
      await server.close();
    }
  });

  it('requires independently revocable trust for Actoviq project skills and commands', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-customize-native-trust-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const skillFile = path.join(workDir, '.actoviq', 'skills', 'project-audit', 'SKILL.md');
    const commandFile = path.join(workDir, '.actoviq', 'commands', 'release.md');
    await Promise.all([
      mkdir(path.dirname(skillFile), { recursive: true }),
      mkdir(path.dirname(commandFile), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(skillFile, ['---', 'name: project-audit', 'description: Audit this project', '---', '', 'Audit.'].join('\n'), 'utf8'),
      writeFile(commandFile, ['---', 'description: Release this project', '---', '', 'Release.'].join('\n'), 'utf8'),
    ]);

    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      type Snapshot = {
        catalog: {
          sources: Array<{ id: string; status: string; needsTrust: boolean }>;
          skills: Array<{ id: string; name: string; sourceId: string }>;
        };
        preferences: { disabledSourceIds: string[]; trustedProjectSourceIds: string[] };
        activeSkillIds: string[];
      };
      const initial = await api<Snapshot>(server, '/api/customize/skills');
      const projectSkill = initial.body.catalog.skills.find(skill => skill.name === 'project-audit')!;
      const projectCommand = initial.body.catalog.skills.find(skill => skill.name === 'release')!;
      expect(initial.body.catalog.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'actoviq:project', status: 'needs-trust' }),
        expect.objectContaining({ id: 'actoviq:project-commands', status: 'needs-trust' }),
      ]));
      expect(initial.body.activeSkillIds).not.toEqual(expect.arrayContaining([
        projectSkill.id,
        projectCommand.id,
      ]));

      const trustedSkill = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'actoviq:project', enabled: true, trust: true }),
      });
      expect(trustedSkill.body.activeSkillIds).toContain(projectSkill.id);
      expect(trustedSkill.body.activeSkillIds).not.toContain(projectCommand.id);

      const trustedCommand = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'actoviq:project-commands', enabled: true, trust: true }),
      });
      expect(trustedCommand.body.activeSkillIds).toEqual(expect.arrayContaining([
        projectSkill.id,
        projectCommand.id,
      ]));

      const revoked = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'source', sourceId: 'actoviq:project-commands', enabled: false, trust: false }),
      });
      expect(revoked.body.preferences.trustedProjectSourceIds).not.toContain('actoviq:project-commands');
      expect(revoked.body.preferences.disabledSourceIds).toContain('actoviq:project-commands');
      expect(revoked.body.activeSkillIds).toContain(projectSkill.id);
      expect(revoked.body.activeSkillIds).not.toContain(projectCommand.id);
    } finally {
      await server.close();
    }
  });

  it('sets and clears a preferred conflict variant without changing either runtime source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'actoviq-gui-customize-conflict-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const codexFile = path.join(workDir, '.codex', 'skills', 'shared-review', 'SKILL.md');
    const claudeFile = path.join(workDir, '.claude', 'skills', 'shared-review', 'SKILL.md');
    const codexText = ['---', 'name: shared-review', 'description: Codex review variant', '---', '', 'Review with Codex conventions.', ''].join('\n');
    const claudeText = ['---', 'name: shared-review', 'description: Claude review variant', '---', '', 'Review with Claude conventions.', ''].join('\n');
    await Promise.all([mkdir(path.dirname(codexFile), { recursive: true }), mkdir(path.dirname(claudeFile), { recursive: true })]);
    await Promise.all([writeFile(codexFile, codexText, 'utf8'), writeFile(claudeFile, claudeText, 'utf8')]);

    const server = await startActoviqGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 45000 + Math.floor(Math.random() * 10000),
    });

    try {
      type Snapshot = {
        catalog: { skills: Array<{ id: string; name: string; sourceId: string }> };
        preferences: { preferredSkillIds: Record<string, string> };
        activeSkillIds: string[];
        skippedConflicts: Array<{ name: string; skillIds: string[] }>;
      };
      for (const sourceId of ['codex:project', 'claude-code:project']) {
        const trusted = await api<Snapshot>(server, '/api/customize/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'source', sourceId, enabled: true, trust: true }),
        });
        expect(trusted.status).toBe(200);
      }

      const unresolved = await api<Snapshot>(server, '/api/customize/skills');
      const variants = unresolved.body.catalog.skills.filter(skill => skill.name === 'shared-review');
      expect(variants).toHaveLength(2);
      expect(unresolved.body.skippedConflicts).toContainEqual(expect.objectContaining({ name: 'shared-review' }));
      expect(unresolved.body.activeSkillIds).not.toContain(variants[0]!.id);
      expect(unresolved.body.activeSkillIds).not.toContain(variants[1]!.id);

      const chosen = variants.find(skill => skill.sourceId === 'codex:project')!;
      const preferred = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prefer', name: 'shared-review', skillId: chosen.id }),
      });
      expect(preferred.status).toBe(200);
      expect(preferred.body.preferences.preferredSkillIds['shared-review']).toBe(chosen.id);
      expect(preferred.body.activeSkillIds).toContain(chosen.id);

      const cleared = await api<Snapshot>(server, '/api/customize/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prefer', name: 'shared-review', clear: true }),
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.preferences.preferredSkillIds).not.toHaveProperty('shared-review');
      expect(cleared.body.skippedConflicts).toContainEqual(expect.objectContaining({ name: 'shared-review' }));
      expect(cleared.body.activeSkillIds).not.toContain(chosen.id);
      expect(await readFile(codexFile, 'utf8')).toBe(codexText);
      expect(await readFile(claudeFile, 'utf8')).toBe(claudeText);
    } finally {
      await server.close();
    }
  });
});
