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
    expect(filterSlashCommands('/agents r')).toEqual(['agents runs']);
    expect(SUBCOMMANDS.agents).toEqual(['list', 'runs', 'show', 'open']);
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
      'issues',
      'manager',
      'bridge',
      'exit',
    ]);
  });

  it('renders GUI shell controls for the interactive surface', () => {
    const html = createActoviqGuiHtml();
    const css = createActoviqGuiStyles();
    const js = createActoviqGuiClientScript();
    const gui = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    const tui = readFileSync(join(import.meta.dirname, '..', 'src', 'tui', 'actoviqTui.ts'), 'utf8');

    expect(html).not.toContain('id="commands"');
    expect(html).not.toContain('class="command-section"');
    expect(html).not.toContain('id="projects"');
    expect(html).not.toContain('id="newWorkspaceBtn"');
    expect(html).not.toContain('id="newProjectSessionBtn"');
    expect(html).not.toContain('id="commandSearch"');
    expect(html).not.toContain('class="project-section"');
    expect(html).not.toContain('id="newChatInlineBtn"');
    expect(html).not.toContain('id="showMoreSessions"');
    expect(html).not.toContain('id="sessions"');
    expect(html).not.toContain('id="projectMenuBtn"');
    expect(html).toContain('id="sidebarRecents"');
    expect(html).toContain('id="overviewNewWorkspaceBtn"');
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
    expect(html).toContain('id="settingsRouterStatus"');
    expect(html).toContain('id="settingsDisableRouter"');
    expect(html).toContain('id="settingsRoutersList"');
    expect(html).toContain('id="agentProfilesList"');
    expect(html).toContain('id="agentProfileNew"');
    expect(html).toContain('id="agentProfileEditorModal"');
    expect(html).toContain('id="agentProfileBridge"');
    expect(html).toContain('id="agentProfileModelSelect"');
    expect(html).toContain('id="routerNewProfile"');
    expect(html).toContain('id="routerEditorModal"');
    expect(html).toContain('id="routerCfgSave"');
    expect(html).not.toContain('id="settingsRuntimeModel"');
    expect(html).not.toContain('id="settingsRuntimeEffort"');
    expect(html).not.toContain('id="settingsRouterSelect"');
    expect(html).toContain('id="settingsToolsList"');
    expect(html).toContain('id="settingsSkillsList"');
    expect(html).toContain('id="settingsAgentsList"');
    expect(html).not.toContain('id="settingsWorkflowsList"');
    expect(js).not.toContain("createAutomationSection('Workflows'");
    expect(js).not.toContain('renderAutomationWorkflowCard');
    expect(html).toContain('Scheduled and webhook-driven tasks');
    expect(html).not.toContain('Workflow scripts and scheduled runs');
    expect(html).toContain('id="settingsTeamsList"');
    expect(html).toContain('<span>Agent</span>');
    expect(html).toContain('aria-label="Agent"');
    expect(html).toContain('<h1>Agent</h1>');
    expect(html).toContain('<h2>Agents</h2>');
    expect(html).toContain('id="navTeam"');
    expect(html).toContain('data-settings-tab="profile"');
    expect(html).toContain('data-settings-tab="browser"');
    expect(html).toContain('data-settings-tab="computer"');
    expect(html).toContain('data-settings-tab="worktree"');
    expect(gui).toContain('createManagedPluginRuntime');
    expect(tui).toContain('createManagedPluginRuntime');
    expect(gui).toContain('readManagedPluginCatalog');
    expect(tui).toContain('readManagedPluginCatalog');
    expect(html).not.toContain('wip-hidden');
    expect(html).not.toContain('settings-wip-note');
    expect(js).toContain('Graph (team)');
    expect(js).toContain("label: 'Graph (team)'");
    expect(js).toContain("label: 'Blank'");
    expect(js).toContain("label: 'Parallel panel'");
    expect(js).toContain("label: 'Review loop'");
    expect(js).toContain('/api/team/scaffold');
    expect(js).toContain('/api/team/apply-block');
    expect(js).toContain('/api/team/validate');
    expect(js).toContain('Insert Parallel');
    expect(js).toContain('Insert Loop');
    expect(js).toContain('openInsertParallelDialog');
    expect(js).toContain('openInsertLoopDialog');
    expect(js).toContain('Need Dispatch → agents → Exit');
    expect(js).toContain('Design with agent');
    expect(js).toContain('/api/team/propose');
    expect(js).toContain('openTeamDesignerDrawer');
    expect(js).not.toContain('First Return reached ends the graph');
    expect(js).toContain('squadTypeLabel');
    expect(gui).toContain('/api/team/scaffold');
    expect(gui).toContain('/api/team/apply-block');
    expect(gui).toContain('/api/team/validate');
    expect(gui).toContain('buildGraphTeamFromTemplate');
    expect(gui).toContain('insertParallelBlock');
    expect(gui).toContain('insertLoopBlock');
    expect(html).toContain('id="settingsSessionsList"');
    expect(html).toContain('id="settingsMemoryStatusBtn"');
    expect(html).toContain('id="conversationIssuePill"');
    expect(html).toContain('class="settings-icon"');
    expect(html).not.toContain('<span>mdl</span>');
    expect(html).not.toContain('<span>cap</span>');
    expect(html).not.toContain('<span>chat</span>');
    expect(html).not.toContain('<span>mem</span>');
    expect(html).toContain('id="squadRoster"');
    expect(html).not.toContain('id="convActionBar"');
    expect(html).toContain('id="contextRail"');
    expect(html).toContain('id="sendBtn"');
    expect(html).toContain('id="settingsStatus"');
    expect(html).toContain('settings-autosave-status');
    expect(html).not.toContain('id="saveSettingsBtn"');
    expect(html).not.toContain('id="cancelSettings"');
    expect(html).toContain('id="backToAppBtn"');
    expect(html).toContain('id="openLocationBtn"');
    // The command-palette / tools / abort (×) / top-bar Terminal & Git buttons were
    // removed; Git lives in the aux side panel, abort moved onto the send button.
    expect(html).not.toContain('id="abortBtn"');
    expect(html).not.toContain('id="commandPaletteBtn"');
    expect(html).not.toContain('id="toolsBtn"');
    expect(html).not.toContain('id="gitBtn"');
    expect(html).not.toContain('id="terminalToggleBtn"');
    expect(html).toContain('data-aux="git"');
    expect(html).toContain('id="contextMenu"');
    expect(html).toContain('id="settingsGitTreeBtn"');
    expect(html).toContain('class="brand"');
    expect(html).toContain('id="settingsOutputStyle"');
    expect(html).toContain('id="settingsOpenMemory"');
    expect(html).toContain('id="settingsShortcutsList"');
    expect(html).toContain('id="settingsHooksList"');
    expect(html).toContain('id="settingsProjectGitBtn"');
    expect(html).toContain('id="settingsShowBranchInComposer"');
    expect(js).toContain('/api/hooks');
    expect(js).toContain('refreshHooksSettings');
    expect(js).toContain('renderShortcutsPanel');
    expect(js).toContain('showBranchInComposer');
    expect(css).toContain('.sidebar');
    expect(html).toContain('id="sidebarRecents"');
    expect(html).toContain('id="sidebarPinnedList"');
    expect(html).toContain('id="sidebarRecentList"');
    expect(css).toContain('.sidebar-recents');
    expect(css).toContain('.sr-project-row');
    expect(js).toContain('renderSidebarRecents');
    expect(js).toContain('/api/project/pin');
    expect(js).toContain('setProjectPinned');
    expect(js).toMatch(/async function openSidebarProject[\s\S]*?await switchRegion\('project'\);[\s\S]*?switchProjectView\('detail'\);/);
    expect(js).toMatch(/async function openSidebarSession[\s\S]*?await switchRegion\('project'\);[\s\S]*?switchProjectView\('conversation'\);/);
    expect(html).not.toContain('id="addProjectBtn"');
    expect(html).not.toContain('id="workspaceMeta"');
    expect(css).toContain('.pc-badge.status-planning');
    expect(css).toContain('.pc-badge.status-not_started');
    expect(js).toContain("status-' + status");
    expect(js).not.toContain('pc-current-chip');
    expect(js).not.toContain('pc-active-badge');
    expect(css).not.toContain('.proj-card.active');
    expect(html).toContain('All statuses');
    expect(html).not.toContain('全部状态');
    expect(html).not.toContain('规划中');
    expect(css).toContain('.composer');
    expect(css).toContain('.workspace-choice-list');
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
    expect(js).toContain("view === 'conversation'");
    expect(js).toContain('void hydrateTranscript()');
    expect(gui).toContain('state({ light: true })');
    expect(gui).toContain('projectSessionOverview');
    expect(js).toContain('/api/pick-folder');
    expect(js).toContain('pickFolderViaApi');
    expect(js).toContain('createNewSession');
    expect(js).toContain('submitWorkspace');
    expect(js).toContain('renderWorkspaceChoices');
    expect(js).toContain('addToolActivity');
    expect(js).toContain('updateToolActivity');
    expect(js).toContain('addFiles');
    expect(js).toContain('buildSubmissionText');
    expect(js).toContain('renderSettingsCommandPanels');
    expect(js).toContain('runSettingsCommand');
    expect(js).toContain('wireSettingsAutosave');
    expect(js).toContain('persistSettingsNow');
    expect(js).toContain('openRouterEditor');
    expect(js).toContain('saveRouterProfileViaApi');
    expect(js).toContain('renderAgentProfiles');
    expect(js).toContain('saveAgentProfileViaApi');
    expect(js).toContain('/api/agent-profiles');
    expect(js).toContain('/api/router/profile');
    expect(js).not.toContain('settingsApplyRuntimeModel');
    expect(js).toContain('/model router ');
    expect(js).toContain('/workflows run ');
    expect(js).toContain('/team attach ');
    expect(js).toContain('/dream run');
    expect(js).toContain('overviewNewWorkspaceBtn');
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
    expect(css).toContain('.settings-autosave-status');
    expect(css).not.toContain('.settings-savebar');
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
    expect(js).toContain('let sessionResumeQueue = Promise.resolve()');
    expect(js).toContain('function setSessionResumePending');
    expect(js).toContain('async function performResumeSession');
    expect(js).toContain("api('/api/session/active')");
    expect(js).not.toContain('refreshSessionInBackground');
    expect(js).toContain('renderMarkdownInto');
    expect(js).toContain('updateStreamingToolInput');
    expect(js).toContain("event.type === 'tool.input.delta'");
    expect(js).toContain("event.type === 'thinking.delta'");
    expect(js).toContain('detailArchivedExpanded');
    expect(js).toContain('mountProjectDoc');
    expect(js).toContain('renderProjectDocPreview');
    expect(js).toContain('project-doc-view');
    expect(js).toContain('/api/issues');
    expect(js).toContain('/api/issues/start');

    const managerUpdateStart = tui.indexOf('const conversationSummaries = stored');
    const managerUpdateEnd = tui.indexOf('const plan =', managerUpdateStart);
    expect(tui.slice(managerUpdateStart, managerUpdateEnd)).toContain(".filter((s) => s.kind !== 'manager')");
    expect(js).toContain('renderProjectIssuesPanel');
    expect(js).toContain('ISSUE_CREATE_TITLE_REQUIRED');
    expect(js).toContain('aria-required="true" aria-label="New issue title"');
    expect(js).toContain('issueDispatchAgent');
    expect(js).toContain('startIssueWithAgent');
    expect(js).toContain('Start with agent');
    expect(js).toContain('issue.dispatched');
    expect(js).toContain('updateConversationIssuePill');
    expect(js).toContain('buildIssueSessionsPanel');
    expect(js).toContain('openLinkedIssue');
    expect(js).toContain('openIssueSession');
    expect(gui).toContain('streamIssueDispatch');
    expect(gui).toContain('buildDecomposeIssuePrompt');
    expect(gui).toContain('IssueReport');
    expect(gui).toContain('resolveAgentProfileRun');
    expect(gui).toContain("case 'tool.input.delta'");
    expect(tui).toContain("case 'tool.input.delta'");
    expect(tui).toContain('preparing ${name}');
    expect(css).toContain('.project-issues-panel');
    expect(css).toContain('.issue-board');
    expect(css).toContain('.issue-dispatch-row');
    expect(css).toContain('.issue-sessions-panel');
    expect(css).toContain('.conv-issue-pill');
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
    expect(html).not.toContain('id="settingsTeamPrefsSave"');
    expect(js).toContain('saveTeamPreferencesFromSettings');
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
    expect(js).toContain('managerAddMsg');
    expect(js).toContain('managerAddToolActivity');
    expect(js).toContain('managerTranscriptHydrated');
    expect(js).toContain('hydrateManagerTranscript');
    expect(js).toContain("item.kind === 'manager'");
    expect(css).toContain('.manager-transcript .message.md-prose');
    expect(js).toContain('/api/project-status');
    expect(js).toContain('projectStatusSelect');
    expect(js).toContain('PROJECT_STATUS_LABELS');
    expect(html).toContain('id="managerCfgBridge"');
    expect(html).not.toContain('id="managerConfigBtn"');
    // No client-side fake built-in team placeholders (real list comes from the server).
    expect(js).not.toContain("mode: 'built-in'");
  });

  it('keeps /issues available on all three surfaces (project issue workflow)', () => {
    const root = join(import.meta.dirname, '..');
    expect(SUBCOMMANDS.issues).toEqual(['list', 'show', 'create', 'start', 'review', 'done', 'block']);
    const repl = readFileSync(join(root, 'src', 'cli', 'actoviq-react.ts'), 'utf8');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    const gui = readFileSync(join(root, 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    for (const source of [repl, tui, gui]) {
      expect(source).toContain('/issues [list|show <id>|create <title>|start <id> [agent-profile]|review <id>|done <id>|block <id>]');
      expect(source).toContain('createProjectIssue');
      expect(source).toContain('transitionProjectIssue');
      expect(source).toContain('listProjectIssues');
    }
    expect(repl).toContain('executeProjectIssue');
    expect(tui).toContain('executeProjectIssue');
    expect(gui).toContain('streamIssueDispatch');
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

  it('controls External CLI background work and native history from the TUI', () => {
    const root = join(import.meta.dirname, '..');
    const tui = readFileSync(join(root, 'src', 'tui', 'actoviqTui.ts'), 'utf8');
    const gui = readFileSync(join(root, 'src', 'gui', 'actoviqGui.ts'), 'utf8');
    const html = createActoviqGuiHtml();
    const js = createActoviqGuiClientScript();
    const managedRuntimes = [
      'claude',
      'codex',
      'pi',
      'codewhale',
      'reasonix',
      'crush',
    ];
    expect(SUBCOMMANDS.bridge).toEqual([
      'run',
      'background',
      'runs',
      'stop',
      'status',
      'history',
      'resume',
      'switch',
      'model',
      'config',
      'setup',
      'off',
      'help',
    ]);
    expect(tui).toContain('new ExternalCliRuntimeManager()');
    expect(tui).toContain('listExternalCliSessions({');
    expect(tui).toContain('readExternalCliSession(summary.path');
    expect(tui).toContain("const RUNTIME_METADATA_KEY = '__actoviqRuntime'");
    expect(tui).toContain("const EXTERNAL_SESSIONS_METADATA_KEY = '__actoviqExternalSessions'");
    expect(tui).toContain("targetSession.id + '\\u0000' + externalSessionBindingKey");
    expect(tui).toContain('await client.resumeSession(boundNativeSessionId');
    expect(tui).toContain('await rememberExternalNativeSession(externalConfig, externalBridge.session.id)');
    expect(tui).toContain('await persistSessionRuntimeMetadata(session, externalConfig, bridgeModelLabel)');
    expect(tui).toContain("args === 'background' || args.startsWith('background ')");
    expect(tui).toContain("args === 'runs'");
    expect(tui).toContain("args === 'stop' || args.startsWith('stop ')");
    expect(tui).toContain("args === 'status'");
    expect(tui).toContain("args === 'history' || args.startsWith('history ')");
    expect(tui).toContain("args === 'resume' || args.startsWith('resume ')");
    expect(tui).toContain('externalCliRuntimeManager.close()');

    const selectSource = (id: string): string => {
      const start = html.indexOf(`<select id="${id}"`);
      expect(start, id).toBeGreaterThanOrEqual(0);
      const end = html.indexOf('</select>', start);
      expect(end, id).toBeGreaterThan(start);
      return html.slice(start, end);
    };
    const configRuntimeSelect = selectSource('bridgeCfgRuntime');
    const historyRuntimeSelect = selectSource('externalCliHistoryRuntime');
    for (const runtime of managedRuntimes) {
      expect(configRuntimeSelect, `${runtime} config option`)
        .toContain(`<option value="${runtime}">`);
      expect(historyRuntimeSelect, `${runtime} history option`)
        .toContain(`<option value="${runtime}">`);
    }
    expect(historyRuntimeSelect).not.toContain('Claude Code + Codex');

    const runtimeProviderStart = js.indexOf('const RUNTIME_PROVIDER =');
    const runtimeProviderEnd = js.indexOf('function toggleCredentialFields', runtimeProviderStart);
    const runtimeProviderSource = js.slice(runtimeProviderStart, runtimeProviderEnd);
    const authStart = js.indexOf('async function refreshExternalCliAuth');
    const authEnd = js.indexOf('function populateExternalCliRunConfigs', authStart);
    const authSource = js.slice(authStart, authEnd);
    for (const runtime of managedRuntimes) {
      expect(runtimeProviderSource, `${runtime} GUI config gate`).toContain(runtime);
      expect(authSource, `${runtime} GUI auth gate`).toContain(runtime);
    }

    const tuiRuntimeMapStart = tui.indexOf('const RUNTIME_MAP:');
    const tuiRuntimeMapEnd = tui.indexOf('const curProvider', tuiRuntimeMapStart);
    const tuiRuntimeMap = tui.slice(tuiRuntimeMapStart, tuiRuntimeMapEnd);
    for (const runtime of managedRuntimes) {
      expect(tuiRuntimeMap, `${runtime} TUI config gate`).toContain(`${runtime}:`);
    }

    const identityBeforeApiKeyBranch = /authSource:[^\n]+\r?\n\s+credentialProvider: config\.credentialProvider,\r?\n\s+profileName: config\.name,\r?\n\s+\.\.\.\(config\.authSource === 'apiKey'/gu;
    expect(tui.match(identityBeforeApiKeyBranch)).toHaveLength(2);
    expect(gui.match(identityBeforeApiKeyBranch)).toHaveLength(2);

    const editStart = tui.indexOf("if (choice === 'edit')");
    const editEnd = tui.indexOf("if (choice === 'remove')", editStart);
    expect(tui.slice(editStart, editEnd)).toContain('await activateBridgeConfig(updated)');
    const removeEnd = tui.indexOf('// Single-page config editor', editEnd);
    expect(tui.slice(editEnd, removeEnd)).toContain('await disableBridge()');

    const runsStart = tui.indexOf('function printExternalCliRuns');
    const runsEnd = tui.indexOf('function stopExternalCliRun', runsStart);
    const stopEnd = tui.indexOf('async function runBridgePrompt', runsEnd);
    expect(tui.slice(runsStart, runsEnd)).not.toContain('requireActiveExternalCliConfig');
    expect(tui.slice(runsEnd, stopEnd)).not.toContain('requireActiveExternalCliConfig');

    const conflictStart = tui.indexOf('function findConflictingExternalCliRun');
    const conflictEnd = tui.indexOf('function externalCliDisplayText', conflictStart);
    const conflictSource = tui.slice(conflictStart, conflictEnd);
    expect(conflictSource).toContain('run.actoviqSessionId !== targetSession.id');
    expect(conflictSource).toContain('!sameWorkspace(run.cwd, targetWorkDir)');
    expect(conflictSource).toContain("run.status !== 'queued' && run.status !== 'running'");
    expect(conflictSource).toContain('label?.configName === config.name');

    const foregroundStart = tui.indexOf('async function startRun(text: string)');
    const foregroundMarkedRunning = tui.indexOf('running = true', foregroundStart);
    expect(tui.slice(foregroundStart, foregroundMarkedRunning)).toContain('findConflictingExternalCliRun');
    expect(tui.slice(foregroundStart, foregroundMarkedRunning)).toContain('/bridge runs and /bridge stop');

    const startupStart = tui.indexOf('screen.start()');
    const startupEnd = tui.indexOf('renderDynamic()', startupStart);
    expect(tui.slice(startupStart, startupEnd)).toContain('await restoreSessionRuntimeSelection()');

    const statusStart = tui.indexOf('function printBridgeStatus');
    const statusEnd = tui.indexOf('async function printExternalCliHistory', statusStart);
    const statusSource = tui.slice(statusStart, statusEnd);
    expect(statusSource).not.toContain('config.apiKey');
    expect(statusSource).not.toContain('config.baseURL');
    expect(statusSource).not.toContain('config.env');

    const historyStart = statusEnd;
    const historyEnd = tui.indexOf('async function startExternalCliBackgroundRun', historyStart);
    const historySource = tui.slice(historyStart, historyEnd);
    expect(historySource).not.toContain('item.path');
    expect(tui).toContain('parseCrushSessionReferenceDetails(summary.path)');
    expect(historySource).toContain('externalCliHistorySourceLabel(item)');
    expect(historySource).toContain('sourceLabel ?');
    expect(historySource).not.toContain(
      "config.runtime === 'claude' ? 'Claude Code' : 'Codex'",
    );

    const splitHistoryRoots = /homeDir: pointerHomeDir\(\),\r?\n\s+actoviqHomeDir: resolveGuiHomeDir\(\),/gu;
    expect(gui.match(splitHistoryRoots)).toHaveLength(5);

    const guiHistoryStart = js.indexOf('async function loadExternalCliHistory');
    const guiHistoryEnd = js.indexOf('async function openExternalCliHistorySession', guiHistoryStart);
    expect(js.slice(guiHistoryStart, guiHistoryEnd)).toContain("item.sourceLabel || ''");
    expect(js).toContain("nativeSession.summary.sourceLabel || ''");
    expect(gui).toContain('isExternalCliHistoryConfigCompatible(externalSession.summary, config)');
    expect(tui).toContain('externalCliSessionMatchesConfig(item, {');
    const guiHistoryDetailStart = js.indexOf('async function openExternalCliHistorySession');
    const guiHistoryDetailEnd = js.indexOf('function renderBridgeConfigs', guiHistoryDetailStart);
    const guiHistoryDetail = js.slice(guiHistoryDetailStart, guiHistoryDetailEnd);
    expect(guiHistoryDetail).toContain('payload.compatibleConfigNames');
    expect(guiHistoryDetail).toMatch(
      /state\.snapshot = payload;\s+applyLoadedState\(\);\s+renderBridgeConfigs\(\);/u,
    );
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
    const css = createActoviqGuiStyles();
    expect(html).toContain('id="managerConfigForm"');
    expect(html).toContain('id="managerCfgScope"');
    expect(html).toContain('id="managerCfgMirror"');
    expect(html).toContain('id="managerCfgBridge"');
    expect(html).toContain('id="managerCfgModel"');
    expect(html).toContain('<select id="managerCfgModel">');
    expect(html).toContain('value="full-access"');
    expect(html).toContain('Manager stays read-only');
    expect(js).toContain('/api/manager/config');
    expect(js).toContain('bridgeConfig');
    expect(html).toContain('id="managerThinking"');
    expect(html).toContain('id="managerThinkingLabel"');
    expect(css).toContain('.manager-thinking');
    expect(css).toContain('align-items: stretch');
    expect(js).toContain('setManagerThinking');
    expect(js).toContain('fillManagerModelOptions');
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
    expect(js).toContain('teamEdgeModal');
    expect(js).toContain('teamSquadModal');
    expect(js).toContain('closeTeamNodeEditor');
    expect(js).toContain('refreshTeamsSnapshot');
    expect(js).toContain('teamGraphEditable');
    expect(gui).toContain('migrateTeamDefinitionToGraph');
    expect(js).toContain('graphPortNodeEl');
    expect(js).toContain('renderTeamReturnEditorPanel');
    expect(js).toContain('removeGraphAgentNode');
    expect(js).toContain('Remove agent');
    expect(js).toContain('formatTeamGraphEdgeLabel');
    expect(js).toContain("Direction");
    expect(js).toContain('graph-edge-arrow');
    expect(js).toContain('graph-edge-handle');
    expect(js).toContain('defaultEdgeBezierOffsets');
    expect(js).toContain('graphNodeRef');
    expect(js).toContain('computeTeamGraphAutoLayoutLanes');
    expect(js).toContain('resolveEdgeBezierPoints');
    expect(js).toContain('Reset curve');
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
    expect(gui).toContain("case 'team.returned':");
  });

  it('emits syntactically valid GUI client script (template-literal regex escapes)', () => {
    const js = createActoviqGuiClientScript();
    const file = join(tmpdir(), `actoviq-gui-client-${process.pid}.js`);
    writeFileSync(file, js);
    expect(() => execSync(`node --check ${JSON.stringify(file)}`)).not.toThrow();
  });

  it('client script can auto-layout squads missing agent ui positions', () => {
    const js = createActoviqGuiClientScript();
    expect(js).toContain('function graphNodeRef(');
    expect(js.indexOf('function graphNodeRef(')).toBeLessThan(js.indexOf('function computeTeamGraphAutoLayoutLanes('));
  });

  it('ships GUI taskbar icon assets for Electron', () => {
    const root = join(import.meta.dirname, '..');
    expect(existsSync(join(root, 'assets', 'actoviq-icon.png'))).toBe(true);
    expect(existsSync(join(root, 'assets', 'actoviq-icon.ico'))).toBe(true);
  });
});
