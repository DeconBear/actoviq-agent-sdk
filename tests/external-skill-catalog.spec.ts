import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverActoviqSkillCatalog } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  sourceRoot: string,
  directoryName: string,
  content: string,
  capabilities: string[] = [],
): Promise<string> {
  const skillRoot = path.join(sourceRoot, directoryName);
  await mkdir(skillRoot, { recursive: true });
  await Promise.all(capabilities.map(name => mkdir(path.join(skillRoot, name), { recursive: true })));
  const skillFile = path.join(skillRoot, 'SKILL.md');
  await writeFile(skillFile, content, 'utf8');
  return skillFile;
}

function simpleSkill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`;
}

function tomlLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

describe('discoverActoviqSkillCatalog', () => {
  it('discovers every supported user and project source with safe ownership state', async () => {
    const root = await createTempDir('actoviq-skill-catalog-sources-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const actoviqHomeDir = path.join(root, 'actoviq-data');
    const roots = [
      ['actoviq:user', path.join(actoviqHomeDir, 'skills'), false, 'user'],
      ['actoviq:project', path.join(workDir, '.actoviq', 'skills'), false, 'project'],
      ['actoviq:project-commands', path.join(workDir, '.actoviq', 'commands'), false, 'project'],
      ['agents:user', path.join(osHomeDir, '.agents', 'skills'), true, 'user'],
      ['agents:project', path.join(workDir, '.agents', 'skills'), true, 'project'],
      ['claude-code:user', path.join(osHomeDir, '.claude', 'skills'), true, 'user'],
      ['claude-code:project', path.join(workDir, '.claude', 'skills'), true, 'project'],
      ['codex:user', path.join(osHomeDir, '.codex', 'skills'), true, 'user'],
      ['codex:project', path.join(workDir, '.codex', 'skills'), true, 'project'],
      ['cursor:user', path.join(osHomeDir, '.cursor', 'skills'), true, 'user'],
      ['cursor:project', path.join(workDir, '.cursor', 'skills'), true, 'project'],
      ['cc-switch:user', path.join(osHomeDir, '.cc-switch', 'skills'), true, 'user'],
      ['cc-switch:project', path.join(workDir, '.cc-switch', 'skills'), true, 'project'],
    ] as const;

    for (const [sourceId, sourceRoot] of roots) {
      await writeSkill(sourceRoot, sourceId.replace(':', '-'), simpleSkill(sourceId.replace(':', '-')));
    }
    await writeSkill(
      path.join(osHomeDir, '.codex', 'skills', '.system'),
      'must-not-appear',
      simpleSkill('must-not-appear'),
    );

    const catalog = await discoverActoviqSkillCatalog({
      osHomeDir,
      actoviqHomeDir,
      workDir,
      env: {},
      includeBundledActoviq: false,
    });

    expect(catalog.sources).toHaveLength(roots.length);
    expect(catalog.skills).toHaveLength(roots.length);
    expect(catalog.skills.some(skill => skill.name === 'must-not-appear')).toBe(false);
    for (const [sourceId, , readOnly, scope] of roots) {
      const source = catalog.sources.find(candidate => candidate.id === sourceId);
      expect(source).toMatchObject({
        id: sourceId,
        readOnly,
        needsTrust: scope === 'project',
        status: scope === 'project' ? 'needs-trust' : 'ready',
        skillCount: 1,
      });
      const skill = catalog.skills.find(candidate => candidate.sourceId === sourceId);
      expect(skill).toMatchObject({
        readOnly,
        needsTrust: scope === 'project',
        status: scope === 'project' ? 'needs-trust' : 'ready',
      });
    }
  });

  it('honors native CLI home overrides and parses common frontmatter forms without writing files', async () => {
    const root = await createTempDir('actoviq-skill-catalog-frontmatter-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const claudeConfigDir = path.join(root, 'custom-claude');
    const codexHome = path.join(root, 'custom-codex');
    const quotedFile = await writeSkill(
      path.join(claudeConfigDir, 'skills'),
      'friendly skill',
      `---
name: "friendly-skill"
description: "Quoted # description" # trailing comment
version: '1.2.3'
allowed-tools: [Read, "Bash(git status)", Write]
---

# ignored fallback
`,
      ['assets', 'scripts'],
    );
    await writeSkill(
      path.join(codexHome, 'skills'),
      'folded-skill',
      `---
name: folded-skill
description: >
  first line
  second line

  next paragraph
---
`,
    );
    await writeSkill(
      path.join(osHomeDir, '.cursor', 'skills'),
      'literal-skill',
      `---
name: literal-skill
description: |
  first line
  second line
---
`,
    );
    await writeSkill(
      path.join(osHomeDir, '.claude', 'skills'),
      'default-claude-must-not-appear',
      simpleSkill('default-claude-must-not-appear'),
    );
    await writeSkill(
      path.join(osHomeDir, '.codex', 'skills'),
      'default-codex-must-not-appear',
      simpleSkill('default-codex-must-not-appear'),
    );
    const before = await readFile(quotedFile, 'utf8');

    const catalog = await discoverActoviqSkillCatalog({
      osHomeDir,
      workDir,
      actoviqHomeDir: path.join(root, 'actoviq-data'),
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome },
      includeBundledActoviq: false,
    });

    expect(catalog.skills.map(skill => skill.name)).not.toContain('default-claude-must-not-appear');
    expect(catalog.skills.map(skill => skill.name)).not.toContain('default-codex-must-not-appear');
    expect(catalog.skills.find(skill => skill.name === 'friendly-skill')).toMatchObject({
      aliases: ['friendly skill'],
      description: 'Quoted # description',
      version: '1.2.3',
      declaredAllowedTools: ['Bash(git status)', 'Read', 'Write'],
      capabilities: ['assets', 'scripts'],
      readOnly: true,
    });
    expect(catalog.skills.find(skill => skill.name === 'folded-skill')?.description)
      .toBe('first line second line\nnext paragraph');
    expect(catalog.skills.find(skill => skill.name === 'literal-skill')?.description)
      .toBe('first line\nsecond line');
    expect(catalog.skills.find(skill => skill.name === 'friendly-skill'))
      .not.toHaveProperty('allowedTools');
    expect(catalog.skills.find(skill => skill.name === 'friendly-skill'))
      .not.toHaveProperty('permissions');
    expect(await readFile(quotedFile, 'utf8')).toBe(before);
  });

  it('discovers skills only from enabled installed Claude Code plugins with stable ids', async () => {
    const root = await createTempDir('actoviq-skill-catalog-claude-plugins-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const claudeConfigDir = path.join(osHomeDir, '.claude');
    const enabledPluginRoot = path.join(root, 'installed', 'review-tools');
    const disabledPluginRoot = path.join(root, 'installed', 'disabled-tools');
    const enabledSkillFile = await writeSkill(
      path.join(enabledPluginRoot, 'skills'),
      'review',
      simpleSkill('review'),
    );
    await writeSkill(
      path.join(disabledPluginRoot, 'skills'),
      'disabled-review',
      simpleSkill('disabled-review'),
    );
    await writeSkill(
      path.join(claudeConfigDir, 'plugins', 'cache', 'team', 'cached-only', '1.0.0', 'skills'),
      'cached-only',
      simpleSkill('cached-only'),
    );
    await mkdir(path.join(claudeConfigDir, 'plugins'), { recursive: true });
    await writeFile(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({
      enabledPlugins: {
        'review-tools@team': true,
        'disabled-tools@team': false,
        'not-installed@team': true,
      },
    }), 'utf8');
    await writeFile(path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'review-tools@team': [{ scope: 'user', installPath: enabledPluginRoot }],
        'disabled-tools@team': [{ scope: 'user', installPath: disabledPluginRoot }],
      },
    }), 'utf8');

    const options = {
      osHomeDir,
      workDir,
      actoviqHomeDir: path.join(root, 'actoviq-data'),
      env: {},
      includeBundledActoviq: false,
      includeMissingSources: false,
    } as const;
    const firstCatalog = await discoverActoviqSkillCatalog(options);

    expect(firstCatalog.sources).toEqual([expect.objectContaining({
      id: 'claude-code:plugin:review-tools@team',
      provider: 'claude-code',
      root: path.join(enabledPluginRoot, 'skills'),
      readOnly: true,
      skillCount: 1,
    })]);
    expect(firstCatalog.skills).toEqual([expect.objectContaining({
      name: 'review-tools:review',
      directoryName: 'review',
      provider: 'claude-code',
      readOnly: true,
    })]);
    expect(firstCatalog.skills.map(skill => skill.name)).not.toEqual(expect.arrayContaining([
      'disabled-tools:disabled-review',
      'cached-only:cached-only',
    ]));

    const firstSkill = firstCatalog.skills[0]!;
    await writeFile(
      enabledSkillFile,
      `---\nname: review\ndescription: updated review description\n---\n\nUpdated content.\n`,
      'utf8',
    );
    const updatedSkill = (await discoverActoviqSkillCatalog(options)).skills[0]!;
    expect(updatedSkill.id).toBe(firstSkill.id);
    expect(updatedSkill.contentHash).not.toBe(firstSkill.contentHash);
    expect(updatedSkill.description).toBe('updated review description');
  });

  it('resolves Claude project and local plugin settings to the installation for the active workspace', async () => {
    const root = await createTempDir('actoviq-skill-catalog-claude-scopes-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const otherWorkDir = path.join(root, 'other-project');
    const claudeConfigDir = path.join(osHomeDir, '.claude');
    const userRoot = path.join(root, 'installed', 'scope-tools-user');
    const projectRoot = path.join(root, 'installed', 'scope-tools-project');
    const otherProjectRoot = path.join(root, 'installed', 'scope-tools-other');
    const localRoot = path.join(root, 'installed', 'local-tools-project');
    const otherLocalRoot = path.join(root, 'installed', 'local-tools-other');
    await Promise.all([
      writeSkill(path.join(userRoot, 'skills'), 'user-copy', simpleSkill('user-copy')),
      writeSkill(path.join(projectRoot, 'skills'), 'project-copy', simpleSkill('project-copy')),
      writeSkill(path.join(otherProjectRoot, 'skills'), 'other-copy', simpleSkill('other-copy')),
      writeSkill(path.join(localRoot, 'skills'), 'local-copy', simpleSkill('local-copy')),
      writeSkill(path.join(otherLocalRoot, 'skills'), 'other-local-copy', simpleSkill('other-local-copy')),
      mkdir(path.join(claudeConfigDir, 'plugins'), { recursive: true }),
      mkdir(path.join(workDir, '.claude'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({
        enabledPlugins: {
          'scope-tools@team': true,
          'local-tools@team': false,
          'local-off@team': true,
        },
      }), 'utf8'),
      writeFile(path.join(workDir, '.claude', 'settings.json'), JSON.stringify({
        enabledPlugins: {
          'scope-tools@team': true,
          'local-tools@team': false,
          'local-off@team': true,
        },
      }), 'utf8'),
      writeFile(path.join(workDir, '.claude', 'settings.local.json'), JSON.stringify({
        enabledPlugins: {
          'local-tools@team': true,
          'local-off@team': false,
        },
      }), 'utf8'),
      writeFile(path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2,
        plugins: {
          'scope-tools@team': [
            { scope: 'user', installPath: userRoot },
            { scope: 'project', projectPath: otherWorkDir, installPath: otherProjectRoot },
            { scope: 'project', projectPath: workDir, installPath: projectRoot },
          ],
          'local-tools@team': [
            { scope: 'local', projectPath: otherWorkDir, installPath: otherLocalRoot },
            { scope: 'local', projectPath: workDir, installPath: localRoot },
          ],
          'local-off@team': [{ scope: 'user', installPath: userRoot }],
        },
      }), 'utf8'),
    ]);

    const catalog = await discoverActoviqSkillCatalog({
      osHomeDir,
      workDir,
      actoviqHomeDir: path.join(root, 'actoviq-data'),
      env: {},
      includeBundledActoviq: false,
      includeMissingSources: false,
    });

    expect(catalog.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'claude-code:plugin:scope-tools@team',
        root: path.join(projectRoot, 'skills'),
        scope: 'project',
        status: 'needs-trust',
      }),
      expect.objectContaining({
        id: 'claude-code:plugin:local-tools@team',
        root: path.join(localRoot, 'skills'),
        scope: 'project',
        status: 'needs-trust',
      }),
    ]));
    expect(catalog.skills.map(skill => skill.name)).toEqual([
      'local-tools:local-copy',
      'scope-tools:project-copy',
    ]);
    expect(catalog.skills.map(skill => skill.name)).not.toEqual(expect.arrayContaining([
      'scope-tools:user-copy',
      'scope-tools:other-copy',
      'local-tools:other-local-copy',
      'local-off:user-copy',
    ]));
  });

  it('discovers only enabled Codex plugin skills from exact marketplace or unambiguous cache roots', async () => {
    const root = await createTempDir('actoviq-skill-catalog-codex-plugins-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const codexHome = path.join(osHomeDir, '.codex');
    const marketplaceRoot = path.join(root, 'marketplace');
    const cacheRoot = path.join(codexHome, 'plugins', 'cache');
    await writeSkill(
      path.join(marketplaceRoot, 'plugins', 'from-source', 'skills'),
      'source-skill',
      simpleSkill('source-skill'),
    );
    await writeSkill(
      path.join(cacheRoot, 'source-market', 'from-source', '1.0.0', 'skills'),
      'source-cache-decoy',
      simpleSkill('source-cache-decoy'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'latest-plugin', 'latest', 'skills'),
      'latest-skill',
      simpleSkill('latest-skill'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'latest-plugin', '1.0.0', 'skills'),
      'stale-skill',
      simpleSkill('stale-skill'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'single-plugin', '2.0.0', 'skills'),
      'single-skill',
      simpleSkill('single-skill'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'ambiguous-plugin', '1.0.0', 'skills'),
      'ambiguous-one',
      simpleSkill('ambiguous-one'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'ambiguous-plugin', '2.0.0', 'skills'),
      'ambiguous-two',
      simpleSkill('ambiguous-two'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'disabled-plugin', '1.0.0', 'skills'),
      'disabled-skill',
      simpleSkill('disabled-skill'),
    );
    await writeSkill(
      path.join(cacheRoot, 'cache-market', 'not-configured', '1.0.0', 'skills'),
      'not-configured-skill',
      simpleSkill('not-configured-skill'),
    );
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), `
[marketplaces.source-market]
source = ${tomlLiteral(marketplaceRoot)}

[plugins."from-source@source-market"]
enabled = true

[plugins."latest-plugin@cache-market"]
enabled = true

[plugins."single-plugin@cache-market"]
enabled = true

[plugins."ambiguous-plugin@cache-market"]
enabled = true

[plugins."disabled-plugin@cache-market"]
enabled = false
`, 'utf8');

    const catalog = await discoverActoviqSkillCatalog({
      osHomeDir,
      workDir,
      actoviqHomeDir: path.join(root, 'actoviq-data'),
      env: {},
      includeBundledActoviq: false,
      includeMissingSources: false,
    });

    expect(catalog.skills.map(skill => skill.name)).toEqual([
      'from-source:source-skill',
      'latest-plugin:latest-skill',
      'single-plugin:single-skill',
    ]);
    expect(catalog.skills.every(skill => skill.provider === 'codex' && skill.readOnly)).toBe(true);
    expect(catalog.sources.map(source => source.id)).toEqual([
      'codex:plugin:from-source@source-market',
      'codex:plugin:latest-plugin@cache-market',
      'codex:plugin:single-plugin@cache-market',
    ]);
    expect(catalog.skills.map(skill => skill.name)).not.toEqual(expect.arrayContaining([
      'from-source:source-cache-decoy',
      'latest-plugin:stale-skill',
      'ambiguous-plugin:ambiguous-one',
      'ambiguous-plugin:ambiguous-two',
      'disabled-plugin:disabled-skill',
      'not-configured:not-configured-skill',
    ]));
  });

  it('deduplicates canonical paths and equal content while reporting distinct-content conflicts', async () => {
    const root = await createTempDir('actoviq-skill-catalog-dedupe-');
    const osHomeDir = path.join(root, 'home');
    const workDir = path.join(root, 'project');
    const sharedConfigDir = path.join(osHomeDir, '.agents');
    const codexHome = path.join(root, 'custom-codex');
    const sameContent = `---\nname: shared\ndescription: same content\n---\n`;
    await writeSkill(path.join(sharedConfigDir, 'skills'), 'shared', sameContent);
    await writeSkill(path.join(codexHome, 'skills'), 'shared-copy', sameContent);
    await writeSkill(
      path.join(osHomeDir, '.cursor', 'skills'),
      'shared',
      `---\nname: shared\ndescription: different content\n---\n`,
    );

    const catalog = await discoverActoviqSkillCatalog({
      osHomeDir,
      workDir,
      actoviqHomeDir: path.join(root, 'actoviq-data'),
      env: { CLAUDE_CONFIG_DIR: sharedConfigDir, CODEX_HOME: codexHome },
      includeBundledActoviq: false,
    });

    const variants = catalog.skills.filter(skill => skill.name === 'shared');
    expect(variants).toHaveLength(2);
    expect(variants.every(skill => skill.conflict)).toBe(true);
    const identicalVariant = variants.find(skill => skill.description === 'same content');
    expect(identicalVariant?.origins.map(origin => origin.sourceId).sort()).toEqual([
      'agents:user',
      'claude-code:user',
      'codex:user',
    ]);
    expect(catalog.conflicts).toEqual([expect.objectContaining({
      name: 'shared',
      skillIds: expect.arrayContaining(variants.map(skill => skill.id)),
      sourceIds: ['agents:user', 'claude-code:user', 'codex:user', 'cursor:user'],
    })]);
    expect(catalog.summary).toMatchObject({ conflictCount: 1, invocationCount: 1, skillVariantCount: 2 });
  });
});
