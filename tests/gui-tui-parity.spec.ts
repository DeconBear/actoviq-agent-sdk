import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TUI_SLASH_COMMANDS, filterSlashCommands } from '../src/tui/actoviqTui.js';
import {
  ACTOVIQ_INTERACTIVE_COMMANDS,
  SUBCOMMANDS,
  filterInteractiveCommands,
} from '../src/ui/commandSurface.js';
import {
  createActoviqGuiClientScript,
  createActoviqGuiHtml,
  createActoviqGuiStyles,
} from '../src/gui/actoviqGui.js';

describe('TUI and GUI parity', () => {
  it('keeps the TUI slash command surface on the shared command registry', () => {
    expect(TUI_SLASH_COMMANDS).toBe(ACTOVIQ_INTERACTIVE_COMMANDS);
    expect(filterSlashCommands('/wo')).toEqual(filterInteractiveCommands('/wo'));
    expect(Object.keys(ACTOVIQ_INTERACTIVE_COMMANDS)).toEqual([
      'help',
      'clear',
      'init',
      'compact',
      'memory',
      'context',
      'cost',
      'usage',
      'doctor',
      'batch',
      'goal',
      'review',
      'stats',
      'export',
      'model',
      'effort',
      'output-style',
      'permissions',
      'plan',
      'rewind',
      'sessions',
      'resume',
      'tools',
      'skills',
      'agents',
      'mcp',
      'hooks',
      'plugins',
      'dream',
      'workflows',
      'worktree',
      'team',
      'manager',
      'bridge',
      'exit',
    ]);
  });

  it('renders GUI shell controls for the interactive surface', () => {
    const html = createActoviqGuiHtml();
    const css = createActoviqGuiStyles();
    const js = createActoviqGuiClientScript();

    expect(html).not.toContain('id="commands"');
    expect(html).not.toContain('class="command-section"');
    expect(html).toContain('id="projects"');
    expect(html).toContain('id="newWorkspaceBtn"');
    expect(html).toContain('id="newProjectSessionBtn"');
    expect(html).not.toContain('id="newChatInlineBtn"');
    expect(html).not.toContain('id="showMoreSessions"');
    expect(html).not.toContain('id="sessions"');
    expect(html).toContain('id="projectMenuBtn"');
    expect(html).toContain('id="workspaceModal"');
    expect(html).toContain('id="workspaceChoices"');
    expect(html).toContain('id="workspacePathInput"');
    expect(html).toContain('id="workspaceBrowseBtn"');
    expect(html).not.toContain('id="workspaceBrowserList"');
    expect(html).not.toContain('id="workspaceBrowseUp"');
    expect(html).toContain('id="openWorkspaceBtn"');
    expect(html).toContain('id="fileUploadBtn"');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('id="attachmentTray"');
    expect(html).toContain('id="dropOverlay"');
    expect(html).toContain('id="surfaceDrawer"');
    expect(html).toContain('id="slashMenu"');
    expect(html).toContain('id="queueList"');
    expect(html).toContain('id="permissionModal"');
    expect(html).toContain('id="settingsBtn"');
    expect(html).toContain('id="settingsModal"');
    expect(html).toContain('id="settingsApiKey"');
    expect(html).toContain('data-settings-tab="general"');
    expect(html).toContain('data-settings-tab="models"');
    expect(html).toContain('data-settings-tab="capabilities"');
    expect(html).toContain('data-settings-tab="automation"');
    expect(html).toContain('data-settings-tab="sessions"');
    expect(html).toContain('data-settings-tab="memory"');
    expect(html).toContain('id="settingsRuntimeModel"');
    expect(html).toContain('id="settingsRuntimeEffort"');
    expect(html).toContain('id="settingsRouterSelect"');
    expect(html).toContain('id="settingsToolsList"');
    expect(html).toContain('id="settingsSkillsList"');
    expect(html).toContain('id="settingsAgentsList"');
    expect(html).toContain('id="settingsWorkflowsList"');
    expect(html).toContain('id="settingsTeamsList"');
    expect(html).toContain('id="settingsSessionsList"');
    expect(html).toContain('id="settingsMemoryStatusBtn"');
    expect(html).toContain('class="settings-icon"');
    expect(html).not.toContain('<span>mdl</span>');
    expect(html).not.toContain('<span>cap</span>');
    expect(html).not.toContain('<span>chat</span>');
    expect(html).not.toContain('<span>mem</span>');
    expect(html).toContain('id="squadRoster"');
    expect(html).not.toContain('id="convActionBar"');
    expect(html).toContain('id="contextRail"');
    expect(html).toContain('id="sendBtn"');
    expect(html).toContain('id="saveSettingsBtn"');
    expect(html).toContain('id="backToAppBtn"');
    expect(html).toContain('id="openLocationBtn"');
    // The command-palette / tools / abort (×) top-bar buttons were removed; the
    // top bar now hosts a Git-tree button, and abort moved onto the send button.
    expect(html).not.toContain('id="abortBtn"');
    expect(html).not.toContain('id="commandPaletteBtn"');
    expect(html).not.toContain('id="toolsBtn"');
    expect(html).toContain('id="gitBtn"');
    expect(html).toContain('id="contextMenu"');
    expect(html).toContain('id="settingsGitTreeBtn"');
    expect(html).toContain('class="brand"');
    expect(html).toContain('id="settingsOutputStyle"');
    expect(css).toContain('.sidebar');
    expect(css).toContain('.composer');
    expect(css).toContain('.mini-action-btn');
    expect(css).toContain('.project-control-row');
    expect(css).toContain('.project-session-list');
    expect(css).toContain('.project-session-list.current-project-chats');
    expect(css).toContain('.project-chat-row');
    expect(css).toContain('.workspace-choice-list');
    expect(css).toContain('.workspace-meta');
    expect(css).toContain('.tool-card');
    expect(css).toContain('@keyframes spin');
    expect(css).toContain('.attachment-tray');
    expect(css).toContain('.drop-overlay');
    expect(css).toContain('.slash-menu');
    expect(css).toContain('.queue-list');
    expect(css).toContain('.surface-drawer');
    expect(css).toContain('.settings-view');
    expect(css).toContain('.settings-main');
    expect(css).toContain('.settings-card-list');
    expect(css).toContain('.settings-command-row');
    expect(css).toContain('.ui-icon');
    expect(css).toContain('.settings-icon');
    expect(js).toContain('/api/send');
    expect(js).toContain('/api/permission');
    expect(js).toContain('/api/settings');
    expect(js).toContain('/api/open-location');
    expect(js).toContain('/api/project/open');
    expect(js).toContain('/api/pick-folder');
    expect(js).toContain('pickFolderViaApi');
    expect(js).toContain('createNewSession');
    expect(js).toContain('submitWorkspace');
    expect(js).toContain('renderWorkspaceChoices');
    expect(js).toContain('current-project-chats');
    expect(js).toContain('addToolActivity');
    expect(js).toContain('updateToolActivity');
    expect(js).toContain('addFiles');
    expect(js).toContain('buildSubmissionText');
    expect(js).toContain('renderSettingsCommandPanels');
    expect(js).toContain('runSettingsCommand');
    expect(js).toContain('settingsApplyRuntimeModel');
    expect(js).toContain('/model router ');
    expect(js).toContain('/workflows run ');
    expect(js).toContain('/team attach ');
    expect(js).toContain('/dream run');
    expect(js).toContain('newWorkspaceBtn');
    expect(js).toContain('newProjectSessionBtn');
    expect(js).toContain('completeSlash');
    expect(js).toContain('processQueue');
    expect(js).toContain('/api/git');
    expect(js).toContain('/api/session/delete');
    expect(js).toContain('/api/project/forget');
    expect(js).toContain('openGitSurface');
    expect(js).toContain('showContextMenu');
    expect(js).toContain('deleteChat');
    expect(js).toContain('forgetWorkspace');
    expect(js).toContain('updateSendButton');
    expect(css).toContain('.context-menu');
    expect(css).toContain('.git-section');
    expect(css).toContain('.brand ');
    expect(css).toContain('.chat-chrome');
    expect(css).toContain('.workspace-path-row');
    expect(css).toContain('.workspace-path-input');
    expect(js).toContain('pickFolderViaApi');
    expect(js).toContain('workspaceBrowseBtn');
    expect(css).toContain('.md-prose');
    expect(css).toContain('.message-row .md-prose h2.md-h');
    expect(css).toContain('.message-row .message.user');
    expect(css).toContain('.pill-btn.primary:hover');
    expect(css).toContain('.system-event');
    expect(css).toContain('.context-rail');
    expect(js).toContain('renderContextRail');
    expect(js).toContain('renderSquadRoster');
    expect(js).toContain('addMemberMessage');
    expect(js).toContain('TRANSCRIPT_CACHE_TTL_MS');
    expect(js).toContain('transcriptCacheFresh');
    expect(js).toContain('refreshSessionInBackground');
    expect(js).toContain('renderMarkdownInto');
    expect(js).toContain('detailArchivedExpanded');
    expect(js).toContain('mountProjectDoc');
    expect(js).toContain('renderProjectDocPreview');
    expect(js).toContain('project-doc-view');
    expect(js).toContain('conv-sidebar-row');
    expect(js).toContain('renderConvSidebarDetail');
    expect(js).toContain('/api/project-doc');
    expect(css).toContain('.project-doc-panel');
    expect(css).toContain('.conv-sidebar-detail');
    expect(js).toContain('sessionConfigDisplay');
    expect(js).not.toContain('Core Squad');
    expect(js).not.toContain('Test Runner');
    expect(js).toContain('updateLocalBridgeConfig');

    // Project Manager panel (plan M0/M1) + team preferences (plan §3.3).
    expect(html).toContain('id="managerPanel"');
    expect(html).toContain('id="managerFab"');
    expect(html).toContain('id="managerShell"');
    expect(html).toContain('id="managerUpdateBtn"');
    expect(html).toContain('id="managerChatInput"');
    expect(html).toContain('id="managerTranscript"');
    expect(html).toContain('id="settingsTeamAutoInvoke"');
    expect(html).toContain('id="settingsTeamDefaultAttached"');
    expect(html).toContain('id="settingsTeamPrefsSave"');
    expect(css).toContain('.manager-widget');
    expect(css).toContain('.manager-fab');
    expect(css).toContain('.manager-transcript');
    expect(js).toContain('/api/manager/state');
    expect(js).toContain('/api/manager/update');
    expect(js).toContain('/api/manager/chat');
    expect(js).toContain('/api/team/preferences');
    expect(js).toContain('refreshManagerState');
    expect(js).toContain('setManagerUiMode');
    expect(js).toContain('managerBoundWorkDir');
    expect(js).toContain('resetManagerClientState');
    expect(js).toContain("state.projectView === 'detail'");
    expect(js).toContain('renderMarkdownInto(bubble');
    expect(js).toContain('managerTranscriptHydrated');
    expect(js).toContain('hydrateManagerTranscript');
    expect(js).toContain("item.kind === 'manager'");
    expect(css).toContain('.manager-transcript .md-prose');
    // No client-side fake built-in team placeholders (real list comes from the server).
    expect(js).not.toContain("mode: 'built-in'");
  });

  it('keeps /manager chat available on all three surfaces (plan §4.6)', () => {
    const root = join(import.meta.dirname, '..');
    expect(SUBCOMMANDS.manager).toContain('chat');
    expect(SUBCOMMANDS.manager).toContain('update');
    // Each surface must both parse the chat subcommand and show it in usage.
    const repl = readFileSync(join(root, 'src', 'cli', 'actoviq-react.ts'), 'utf8');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    const gui = readFileSync(join(root, 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    for (const source of [repl, tui, gui]) {
      expect(source).toContain('/manager chat <message>');
    }
    expect(repl).toContain("sub === 'chat' || sub.startsWith('chat ')");
    expect(tui).toContain("args === 'chat' || args.startsWith('chat ')");
    expect(gui).toContain("input.startsWith('/manager chat ')");
  });

  it('keeps /team clone available on all three surfaces (plan Phase 1)', () => {
    const root = join(import.meta.dirname, '..');
    expect(SUBCOMMANDS.team).toContain('clone');
    const repl = readFileSync(join(root, 'src', 'cli', 'actoviq-react.ts'), 'utf8');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    const gui = readFileSync(join(root, 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    for (const source of [repl, tui, gui]) {
      expect(source).toContain('cloneTeamDefinition');
      expect(source).toContain("startsWith('clone ')");
    }
  });

  it('keeps manager config knobs (model/readScope/mirror) on all three surfaces (plan M0/M3)', () => {
    const root = join(import.meta.dirname, '..');
    const repl = readFileSync(join(root, 'src', 'cli', 'actoviq-react.ts'), 'utf8');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    for (const source of [repl, tui]) {
      expect(source).toContain("startsWith('config set ')");
      expect(source).toContain('writeManagerConfig');
      expect(source).toContain('read-only regardless of model');
    }
    const html = createActoviqGuiHtml();
    const js = createActoviqGuiClientScript();
    expect(html).toContain('id="managerConfigForm"');
    expect(html).toContain('id="managerCfgScope"');
    expect(html).toContain('id="managerCfgMirror"');
    expect(html).toContain('always runs read-only');
    expect(js).toContain('/api/manager/config');
  });

  it('renders the Team Run tree + graph editor surfaces in the GUI (plan Phase 4/5)', () => {
    const js = createActoviqGuiClientScript();
    const css = createActoviqGuiStyles();
    const gui = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    // Phase 5: TeamEvent-driven run tree (hidden with no team run) + edge lines.
    expect(js).toContain('renderTeamRunTree');
    expect(js).toContain("event.type === 'team.edge.triggered'");
    expect(css).toContain('.team-tree-row');
    // Phase 4: graph editor (nodes/edges/entry/allowedTools + risky-tool confirm
    // + save target + engine-validated save) and the graph-mode canvas.
    expect(js).toContain('renderTeamNodeEditorPanel');
    expect(js).toContain('renderTeamEdgeEditorPanel');
    expect(js).toContain('openTeamNodeEditor');
    expect(js).toContain('teamAgentModal');
    expect(js).toContain('closeTeamNodeEditor');
    expect(js).toContain('refreshTeamsSnapshot');
    expect(js).toContain('teamGraphEditable');
    expect(gui).toContain('migrateTeamDefinitionToV2');
    expect(js).toContain('RISKY_NODE_TOOLS');
    expect(js).not.toContain('/api/team/upgrade');
    expect(gui).toContain('/api/team/upgrade');
    expect(js).toContain('showTeamGraphProblems');
    expect(js).toContain('renderGraphModeCanvas');
    expect(js).toContain('applyGraphAutoLayout');
    expect(js).toContain('wireGraphBoardConnect');
    expect(js).toContain('graph-board');
    expect(js).toContain('saveTargetField');
  });

  it('keeps Team Run tree formatting on all three surfaces (plan Phase 5)', () => {
    const root = join(import.meta.dirname, '..');
    const repl = readFileSync(join(root, 'src', 'cli', 'actoviq-react.ts'), 'utf8');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    const gui = readFileSync(join(root, 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    for (const source of [repl, tui]) {
      expect(source).toContain('formatTeamRunTreeLines');
      expect(source).toContain('applyTeamRunEvent');
    }
    const js = createActoviqGuiClientScript();
    expect(js).toContain('renderTeamRunTree');
    expect(js).toContain("event.type === 'team.edge.triggered'");
    expect(gui).toContain('forwardTeamEvent');
  });

  it('emits syntactically valid GUI client script (template-literal regex escapes)', () => {
    const js = createActoviqGuiClientScript();
    const file = join(tmpdir(), `actoviq-gui-client-${process.pid}.js`);
    writeFileSync(file, js);
    expect(() => execSync(`node --check ${JSON.stringify(file)}`)).not.toThrow();
  });

  it('ships GUI taskbar icon assets for Electron', () => {
    const root = join(import.meta.dirname, '..');
    expect(existsSync(join(root, 'assets', 'actoviq-icon.png'))).toBe(true);
    expect(existsSync(join(root, 'assets', 'actoviq-icon.ico'))).toBe(true);
  });
});
