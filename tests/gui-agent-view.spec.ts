import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  createHadamardGuiClientScript,
  createHadamardGuiHtml,
  createHadamardGuiStyles,
} from '../src/gui/hadamardGui.js';

describe('GUI Project Agent execution view', () => {
  it('emits syntactically valid browser JavaScript', () => {
    expect(() => new Script(createHadamardGuiClientScript())).not.toThrow();
  });

  it('ships a dedicated project tab with a persistent execution-tree contract', () => {
    const js = createHadamardGuiClientScript();
    const css = createHadamardGuiStyles();
    const html = createHadamardGuiHtml();

    expect(js).toContain("['agents', 'Agent monitor']");
    expect(js).toContain("'/api/agent-executions?path='");
    expect(js).toContain("'project-tab-agents'");
    expect(js).toContain("'agent-executions-panel'");
    expect(js).toContain("tabs.setAttribute('role', 'tablist')");
    expect(js).toContain("btn.setAttribute('role', 'tab')");
    expect(js).toContain("panel.setAttribute('role', 'tabpanel')");
    expect(js).toContain("const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(js).toContain("btn.tabIndex = state.projectDetailTab === tab[0] ? 0 : -1");
    expect(js).toContain('btn.tabIndex = active ? 0 : -1');
    expect(js).toContain('function revealActiveProjectDetailTab()');
    expect(js).toContain('tabs.scrollLeft += Math.ceil(activeRect.right - tabsRect.right)');
    expect(js).toContain('requestAnimationFrame(revealActiveProjectDetailTab)');
    expect(js).toContain('if (window.innerWidth > 1120) setDetailConversationDrawer(false)');
    expect(js).toContain('function toggleDetailConversationDrawer()');
    expect(js).toContain("sidebar?.classList.toggle('mobile-open', expanded)");
    expect(js).toContain("if (expanded) requestAnimationFrame(() => el('detailConvSearch')?.focus())");
    expect(js).toContain("sidebar.id = 'projectDetailSidebar'");
    expect(js).toContain("'agent-execution-root-' + root.rootExecutionId");
    expect(js).toContain("'agent-execution-node-' + node.id");
    expect(js).toContain("'agent-node-open-session-' + node.sessionId");
    expect(js).toContain("'agent-conversation-' + conversation.id");
    expect(js).toContain('function appendAgentConversation(host, conversation)');
    expect(js).toContain("head.textContent = 'Conversations (' + conversations.length + ')'");
    expect(js).toContain("conversation.kind === 'manager'");
    expect(js).toContain("conversation.isWaiting");
    expect(js).toContain('const activity = conversation.isRunning || conversation.isWaiting');
    expect(js).toContain("setManagerUiMode('compact')");
    expect(js).toContain("conversation.isCurrent && conversation.isRunning ? 'View live' : 'Open conversation'");
    expect(js).toContain("'agent-edge-' + edge.callId");
    expect(js).toContain('renderAgentExecutionsPanel');
    expect(js).toContain('appendAgentExecutionRoot');
    expect(js).toContain('appendAgentNode');
    expect(js).toContain("resumeSession(node.sessionId)");
    expect(js).toContain("'Detached agents'");
    expect(js).toContain('agentEdgeStatusLabel');
    expect(js).toContain("aria-expanded");
    expect(js).toContain("aria-live', 'polite'");
    expect(js).toContain("head.textContent = 'Running (' + view.active.length + ')'");
    expect(js).toContain("head.textContent = 'Waiting / suspended (' + view.waiting.length + ')'");
    expect(js).toContain("return 'Last activity: ' + summary");

    expect(css).toContain('.agent-execution-panel');
    expect(css).toContain('.agent-execution-node');
    expect(css).toContain('.agent-execution-edge');
    expect(css).toContain('.agent-conversation-row.running');
    expect(css).toContain('.agent-conversation-row.waiting');
    expect(css).toContain('.detail-conversations-toggle:focus-visible');
    expect(css).toContain('@media (max-width: 860px)');
    for (const [id, label] of [
      ['navProject', 'Project'],
      ['navTeam', 'Agent'],
      ['navAutomation', 'Automation'],
      ['navPlugins', 'Customize'],
      ['settingsBtn', 'Settings'],
      ['detailConversationsBtn', 'Conversations'],
      ['detailNewConversationBtn', '+ New conversation'],
    ]) {
      if (id === 'detailNewConversationBtn') {
        expect(html).toContain(`id="${id}"`);
        expect(html).toContain('+ New conversation');
        continue;
      }
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*aria-label="${label}"`));
    }
    expect(html).not.toContain('id="newSession"');
    expect(js).toContain('createNewSession');
    expect(js).not.toContain("el('newSession')");
  });

  it('keeps the project Agent workspace usable at tablet and narrow widths', () => {
    const css = createHadamardGuiStyles();
    const tabletStart = css.indexOf('@media (max-width: 1120px)');
    const tablet = css.slice(tabletStart, css.indexOf('.context-menu', tabletStart));
    const compactStart = css.lastIndexOf('@media (max-width: 860px)');
    const compact = css.slice(compactStart, css.indexOf('@media (max-width: 640px)', compactStart));
    const narrowStart = css.indexOf('@media (max-width: 640px)', compactStart);
    const narrow = css.slice(narrowStart, css.indexOf('.context-bar', narrowStart));

    expect(tablet).toContain('.detail-conversations-toggle { display: inline-flex; }');
    expect(tablet).toContain('.detail-sidebar.mobile-open');
    expect(tablet).toContain('visibility: visible;');
    expect(compact).toContain('.sidebar { width: 56px; flex-basis: 56px; padding: 12px 8px; }');
    expect(compact).toContain('.sidebar-recents');
    expect(compact).toContain('.nav-btn > span:not(.nav-icon) { display: none !important; }');
    expect(narrow).toContain('.project-detail > .region-header');
    expect(narrow).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(narrow).toContain('.detail-conversations-toggle { grid-column: 1 / -1; }');
    expect(narrow).toContain('.project-detail-tabs::-webkit-scrollbar { display: none; }');
  });

  it('guards polling and response commits to the visible project Agent tab', () => {
    const js = createHadamardGuiClientScript();

    expect(js).toContain('const AGENT_EXECUTION_POLL_MS = 2000');
    expect(js).toContain('const AGENT_EXECUTION_IDLE_POLL_MS = 5000');
    expect(js).toContain('function stopAgentExecutionPolling()');
    expect(js).toContain('function scheduleAgentExecutionPolling()');
    expect(js).toContain('!agentExecutionViewIsVisible()');
    expect(js).toContain('state.snapshot?.workDir !== projectPath');
    expect(js).toContain('state.agentExecutionsRequestSeq');
    expect(js).toContain('// The request owns this loading flag even if the user left Agents while it');
    expect(js).toContain('state.agentExecutionsLoading = false;');
    expect(js).toContain('if (state.agentExecutionsLoading) return;');
    expect(js).toContain('if (!state.agentExecutionsLoading) scheduleAgentExecutionPolling();');
    expect(js).toContain('state.agentCompletedLimit += 10');
    expect(js).toContain("'completed-toggle'");
    expect(js).toContain("'agent-executions-empty-refresh'");
    expect(js).toContain('? AGENT_EXECUTION_POLL_MS\n    : AGENT_EXECUTION_IDLE_POLL_MS');

    const switchRegion = js.slice(
      js.indexOf('async function switchRegion(name)'),
      js.indexOf('async function renderAutomationRegion()', js.indexOf('async function switchRegion(name)')),
    );
    expect(switchRegion).toContain("if (name !== 'project') stopAgentExecutionPolling()");
    expect(switchRegion).toContain("state.projectDetailTab === 'agents'");
    expect(switchRegion).toContain('void refreshAgentExecutions(true)');

    const refresh = js.slice(
      js.indexOf('async function refreshAgentExecutions(force)'),
      js.indexOf('function setProjectDetailTab(tab)'),
    );
    expect(refresh.indexOf('state.agentExecutionsLoading = false')).toBeLessThan(
      refresh.lastIndexOf('if (!agentExecutionViewIsVisible()'),
    );
  });

  it('provides configured routers and cascading config/agent model controls', () => {
    const html = createHadamardGuiHtml();
    const js = createHadamardGuiClientScript();
    const css = createHadamardGuiStyles();

    expect(html).toContain('id="modelPickerBtn"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('placeholder="Search models, routers, providers"');
    expect(html).toContain('Ctrl / ⌘ + / to cycle');
    expect(js).toContain("appendPickerRouterSection(items, targets.routers");
    expect(js).toContain("appendPickerSection(items, 'Configurations'");
    expect(js).toContain("appendPickerSection(items, 'Agents'");
    expect(js).toContain('const routers = (snap.routers || []).map');
    expect(js).toContain("api('/api/router/activate'");
    expect(js).not.toContain("label.textContent = 'Auto'");
    expect(js).not.toContain("Use this conversation’s default model");
    expect(js).toContain("modelHeading.textContent = 'Model'");
    expect(js).toContain("effortHeading.textContent = 'Reasoning'");
    expect(js).toContain("ev.key === 'ArrowRight'");
    expect(js).toContain("event.key !== 'ArrowLeft'");
    expect(js).toContain('bridgeConfig: target?.name');
    expect(js).toContain("event.key === '/'");
    expect(js).toContain("event.key === 'ArrowDown'");
    expect(js).toContain('current < 0 ? 0 : Math.min(current + 1');
    expect(js).toContain('current < 0 ? rows.length - 1');
    expect(js).toContain("event.key === 'Home' || event.key === 'End'");
    expect(js).toContain('state.pickerSelectionSequence');
    expect(js).toContain('function positionModelPickerFlyout()');
    expect(js).toContain("button.closest('.workbench-chat')");
    expect(js).toContain('Stop or wait for the active response before switching models.');
    expect(css).toContain('.picker-detail-item');
    expect(css).toContain('.picker-row-trailing');
    expect(css).toContain('.model-picker-btn-copy');
    expect(css).toContain('border-radius: 999px');
    expect(css).toContain('var(--model-picker-menu-width');
    expect(css).toContain('.model-picker-flyout {\n  position: absolute;\n  right: 0;');
    expect(css).toContain('left: calc(100% + 6px)');
    expect(css).toContain('min-height: 30px');
    expect(css).toContain('font-size: 11px');
    expect(js).toContain('const menuWidth = Math.min(248');
    expect(js).toContain('const submenuWidth = menuWidth');
  });

  it('provides a functional add-context catalog from the composer plus button', () => {
    const html = createHadamardGuiHtml();
    const js = createHadamardGuiClientScript();
    const css = createHadamardGuiStyles();

    expect(html).toContain('id="fileUploadBtn"');
    expect(html).toContain('aria-label="Add context"');
    expect(html).toContain('id="addContextMenu"');
    expect(html).toContain('id="folderInput"');
    expect(html).toContain('webkitdirectory');
    expect(js).toContain("title: 'Files'");
    expect(js).toContain("title: 'Folder'");
    expect(js).toContain("title: 'Plugins'");
    expect(js).toContain("title: 'Skills'");
    expect(js).toContain("title: 'Reference conversation'");
    expect(js).toContain("title: 'Search task history'");
    expect(js).toContain("api('/api/session-center/reference'");
    expect(js).toContain('payload.activeSkillIds');
    expect(js).toContain('invoke the registered Skill tool');
    expect(js).toContain('<hadamard-context type="');
    expect(js).toContain("event.key === 'ArrowLeft'");
    expect(css).toContain('.add-context-menu');
    expect(css).toContain('.add-context-row');
    expect(css).toContain('font-size: 12px');
  });

  it('does not let stale state requests overwrite a newer mutation', () => {
    const js = createHadamardGuiClientScript();

    expect(js).toContain('let stateSnapshotLoadSequence = 0');
    expect(js).toContain('const requestSequence = ++stateSnapshotLoadSequence');
    expect(js).toContain('if (requestSequence !== stateSnapshotLoadSequence) return');
    expect(js).toContain('if (requestVersion !== apiMutationVersion)');
    expect(js).toContain('return loadState()');
  });

  it('provides a two-section Customize workspace for plugin and skill management', () => {
    const html = createHadamardGuiHtml();
    const js = createHadamardGuiClientScript();
    const css = createHadamardGuiStyles();
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'hadamardGui.ts'), 'utf8');

    expect(html).toContain('<h1>Customize</h1>');
    expect(html).toContain('id="pluginsViewPluginsBtn"');
    expect(html).toContain('id="pluginsViewSkillsBtn"');
    expect(html).not.toContain('id="pluginsViewToolsBtn"');
    expect(html).not.toContain('id="pluginsViewMcpBtn"');
    expect(js).toContain("let url = '/api/customize/plugins'");
    expect(js).toContain('renderManagedPluginCatalog');
    expect(js).toContain('plugin-detail-panel');
    expect(js).toContain("if (options.type !== 'textarea')");
    expect(js).toContain("document.createElement('form')");
    expect(source).toContain('if (managedPluginRuntimeClose)');
    expect(source).toContain('await managedPluginRuntimeClose()');
    expect(source).toContain('if (managedPluginCloseError) throw managedPluginCloseError');
    expect(js).toContain('Qwen / DashScope');
    expect(js).toContain('E2B isolated desktop');
    expect(js).toContain('Reuse the secure login already managed by GitHub CLI'.replace('Reuse', 'Leave the alternate token empty to reuse'));
    expect(js).toContain('Persistent profile directory');
    expect(js).toContain("api('/api/customize/skills'");
    expect(js).toContain("action: 'source'");
    expect(js).toContain("action: 'skill'");
    expect(js).toContain("action: 'prefer'");
    expect(js).toContain("clear: true");
    expect(js).toContain('Trust & enable');
    expect(js).toContain('Revoke trust');
    expect(js).toContain('discovery or load warning');
    expect(js).toContain('skill.origins || []');
    expect(js).toContain('Clear choice');
    expect(js).toContain('Collapsed by name. Expand a row for details');
    expect(js).toContain('skillCatalogExpanded');
    expect(js).toContain('collectSkillLocations');
    expect(css).toContain('.skill-source-grid');
    expect(css).toContain('.skill-catalog-row.is-active');
    expect(css).toContain('.skill-catalog-row.is-disabled');
    expect(css).toContain('.skill-catalog-row.is-open');
    expect(css).toContain('.region-body { flex: 1; min-height: 0; overflow: auto');
    expect(css).toContain('.plugin-market-grid');
    expect(css).toContain('.plugin-detail');
  });

  it('reconnects foreground runs with sequenced replay and lightweight polling', () => {
    const js = createHadamardGuiClientScript();
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'hadamardGui.ts'), 'utf8');

    expect(js).toContain("api('/api/runs')");
    expect(js).toContain("api('/api/rail-live')");
    expect(js).toContain("'/api/run/events?runId='");
    expect(js).toContain('if (event.sequence <= state.activeRunSequence) return;');
    expect(js).toContain('body: JSON.stringify({ text, clientRequestId })');
    expect(js).toContain('async function initializeGui()');
    expect(js).toContain('await recoverDisconnectedRun(sessionId, true');
    expect(js).toContain("T.applyEvent({ type: 'response.retry' })");
    expect(source).toContain("event.sourceType === 'model.interrupted'");
    expect(source).toContain("type: 'reconnecting'");
    expect(source).toContain('const runReplayTombstones = new Map<string, GuiRunRecord>()');
    expect(source).toContain('retainRunReplay(run)');
    expect(source).toContain('runReplayTombstones.get(runId)');
    expect(source).toContain('if (replayEvents.length > 2_000) replayEvents.shift()');
  });

  it('serializes cached child-session switches before enabling sends', () => {
    const js = createHadamardGuiClientScript();
    const start = js.indexOf('function setSessionResumePending(pending)');
    const end = js.indexOf('function refreshProjectDetailSidebar()', start);
    const resume = js.slice(start, end);
    const activate = resume.slice(
      resume.indexOf('async function activateResumedSession'),
      resume.indexOf('async function reconcileResumedSession'),
    );
    const reconcile = resume.slice(
      resume.indexOf('async function reconcileResumedSession'),
      resume.indexOf('async function performResumeSession'),
    );
    const request = resume.slice(resume.indexOf("const res = await api('/api/session/resume'"));

    expect(js).toContain('let sessionResumeQueue = Promise.resolve()');
    expect(resume).toContain('if (state.sessionResumePending)');
    expect(resume).toContain('.then(() => performResumeSession(id, requestSequence))');
    expect(resume).not.toContain('refreshSessionInBackground');
    expect(activate).toContain("switchProjectView('conversation')");
    expect(request.indexOf('const snapshot = await res.json()')).toBeLessThan(
      request.indexOf('await activateResumedSession(snapshot, requestSequence)'),
    );
    expect(request).toContain('if (res.status < 500)');
    expect(request).toContain('await reconcileResumedSession(id, requestSequence)');
    expect(reconcile).toContain("api('/api/session/active')");
    expect(reconcile).toContain('while (requestSequence === sessionResumeSequence)');
    expect(reconcile).toContain('await new Promise(resolve => setTimeout');

    const send = js.slice(
      js.indexOf('async function sendText(text)'),
      js.indexOf('function handleEvent(event)'),
    );
    expect(send).toContain('if (state.sessionResumePending)');
  });

  it('waits for server-side resume mutations before returning reconciliation state', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'hadamardGui.ts'), 'utf8');
    const activeRoute = source.slice(
      source.indexOf("url.pathname === '/api/session/active'"),
      source.indexOf("url.pathname === '/api/agent-executions'"),
    );
    const resumeRoute = source.slice(
      source.indexOf("url.pathname === '/api/session/resume'"),
      source.indexOf("url.pathname === '/api/permission'"),
    );

    expect(source).toContain('let serverSessionResumeQueue: Promise<void> = Promise.resolve()');
    expect(activeRoute).toContain('await serverSessionResumeQueue');
    expect(resumeRoute).toContain('enqueueServerSessionResume(async () =>');
    expect(resumeRoute.indexOf('enqueueServerSessionResume')).toBeLessThan(resumeRoute.indexOf('readJson(req)'));
  });
});
