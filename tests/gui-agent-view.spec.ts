import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  createActoviqGuiClientScript,
  createActoviqGuiStyles,
} from '../src/gui/actoviqGui.js';

describe('GUI Project Agent execution view', () => {
  it('emits syntactically valid browser JavaScript', () => {
    expect(() => new Script(createActoviqGuiClientScript())).not.toThrow();
  });

  it('ships a dedicated project tab with a persistent execution-tree contract', () => {
    const js = createActoviqGuiClientScript();
    const css = createActoviqGuiStyles();

    expect(js).toContain("['agents', 'Agents']");
    expect(js).toContain("'/api/agent-executions?path='");
    expect(js).toContain("'project-tab-agents'");
    expect(js).toContain("'agent-executions-panel'");
    expect(js).toContain("tabs.setAttribute('role', 'tablist')");
    expect(js).toContain("btn.setAttribute('role', 'tab')");
    expect(js).toContain("panel.setAttribute('role', 'tabpanel')");
    expect(js).toContain("const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    expect(js).toContain("btn.tabIndex = state.projectDetailTab === tab[0] ? 0 : -1");
    expect(js).toContain("btn.tabIndex = btn.dataset.detailTab === next ? 0 : -1");
    expect(js).toContain("'agent-execution-root-' + root.rootExecutionId");
    expect(js).toContain("'agent-execution-node-' + node.id");
    expect(js).toContain("'agent-node-open-session-' + node.sessionId");
    expect(js).toContain("'agent-edge-' + edge.callId");
    expect(js).toContain('renderAgentExecutionsPanel');
    expect(js).toContain('appendAgentExecutionRoot');
    expect(js).toContain('appendAgentNode');
    expect(js).toContain("resumeSession(node.sessionId)");
    expect(js).toContain("'Detached agents'");
    expect(js).toContain('agentEdgeStatusLabel');
    expect(js).toContain("aria-expanded");
    expect(js).toContain("aria-live', 'polite'");

    expect(css).toContain('.agent-execution-panel');
    expect(css).toContain('.agent-execution-node');
    expect(css).toContain('.agent-execution-edge');
    expect(css).toContain('@media (max-width: 860px)');
  });

  it('guards polling and response commits to the visible project Agent tab', () => {
    const js = createActoviqGuiClientScript();

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

  it('serializes cached child-session switches before enabling sends', () => {
    const js = createActoviqGuiClientScript();
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
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'gui', 'actoviqGui.ts'), 'utf8');
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
