import { describe, expect, it } from 'vitest';

import { TUI_SLASH_COMMANDS, filterSlashCommands } from '../src/tui/actoviqTui.js';
import {
  ACTOVIQ_INTERACTIVE_COMMANDS,
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
      'compact',
      'memory',
      'model',
      'effort',
      'permissions',
      'sessions',
      'resume',
      'tools',
      'skills',
      'agents',
      'mcp',
      'plugins',
      'dream',
      'workflows',
      'worktree',
      'team',
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
    expect(html).toContain('id="promptInput"');
    expect(html).toContain('id="insertCommand"');
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
    expect(html.indexOf('id="insertCommand"')).toBeGreaterThan(html.indexOf('id="permissionSelect"'));
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
    expect(css).toContain('.command-chip');
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
    expect(js).toContain('/api/sessions/cleanup');
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
    expect(css).toContain('.settings-help-row');
  });
});
