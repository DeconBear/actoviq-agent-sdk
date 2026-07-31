import * as vscode from 'vscode';

import { AppServerClient } from './appServerClient.js';
import { ApprovalTreeProvider, restoreCheckpoint } from './approvalView.js';
import { applySessionDiff, showSessionDiff } from './diffProvider.js';
import { SessionTreeProvider } from './sessionTree.js';

export function activate(context: vscode.ExtensionContext): void {
  const client = new AppServerClient();
  const sessions = new SessionTreeProvider(client);
  const approvals = new ApprovalTreeProvider(client);
  let activeSessionId = context.workspaceState.get<string>('hadamard.activeSessionId');

  const selectSession = async (): Promise<string | undefined> => {
    const list = await client.request<Array<{ id: string; title: string }>>('session/list');
    const selected = await vscode.window.showQuickPick(
      list.map(session => ({ label: session.title, description: session.id, id: session.id })),
      { placeHolder: 'Choose an Hadamard Session' },
    );
    if (!selected) return undefined;
    activeSessionId = selected.id;
    await context.workspaceState.update('hadamard.activeSessionId', selected.id);
    return selected.id;
  };
  const requireSession = async (): Promise<string | undefined> =>
    activeSessionId ?? selectSession();

  const participant = vscode.chat.createChatParticipant(
    'hadamard.chat',
    async (request, _chatContext, response, token) => {
      let sessionId = await requireSession();
      if (!sessionId) {
        const created = await client.request<{ id: string }>('session/create', {
          title: 'VS Code Chat',
        });
        sessionId = created.id;
        activeSessionId = sessionId;
        await context.workspaceState.update('hadamard.activeSessionId', sessionId);
      }
      const notification = client.onNotification(message => {
        if (token.isCancellationRequested || message.method !== 'session/event') return;
        if (message.params.sessionId !== sessionId) return;
        const event = message.params.event as { type?: string; delta?: string } | undefined;
        if (event?.type === 'response.text.delta' && event.delta) response.markdown(event.delta);
      });
      try {
        const result = await client.request<{ text?: string }>('session/send', {
          sessionId,
          input: request.prompt,
        });
        if (!result.text) response.progress('Hadamard completed without text output.');
        return { metadata: { sessionId } };
      } finally {
        notification.dispose();
      }
    },
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'hadamard.svg');

  context.subscriptions.push(
    client,
    participant,
    vscode.window.registerTreeDataProvider('hadamard.sessions', sessions),
    vscode.window.registerTreeDataProvider('hadamard.approvals', approvals),
    vscode.commands.registerCommand('hadamard.refreshSessions', () => sessions.refresh()),
    vscode.commands.registerCommand('hadamard.selectSession', selectSession),
    vscode.commands.registerCommand('hadamard.newSession', async () => {
      const title = await vscode.window.showInputBox({ prompt: 'Session title' });
      if (title === undefined) return;
      const session = await client.request<{ id: string }>('session/create', { title });
      activeSessionId = session.id;
      await context.workspaceState.update('hadamard.activeSessionId', session.id);
      sessions.refresh();
    }),
    vscode.commands.registerCommand('hadamard.openSession', async (sessionId?: string) => {
      const id = sessionId ?? await vscode.window.showInputBox({ prompt: 'Session id' });
      if (!id) return;
      const session = await client.request<{ title: string; messages: unknown[] }>('session/open', { sessionId: id });
      activeSessionId = id;
      await context.workspaceState.update('hadamard.activeSessionId', id);
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(session, null, 2),
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
    vscode.commands.registerCommand('hadamard.reviewDiff', async () => {
      const id = await requireSession();
      if (id) await showSessionDiff(client, id);
    }),
    vscode.commands.registerCommand('hadamard.applyDiff', async () => {
      const id = await requireSession();
      if (id) await applySessionDiff(client, id);
    }),
    vscode.commands.registerCommand('hadamard.restoreCheckpoint', async () => {
      const id = await requireSession();
      if (id) await restoreCheckpoint(client, id);
    }),
    vscode.commands.registerCommand('hadamard.setGoal', async () => {
      const id = await requireSession();
      if (!id) return;
      const objective = await vscode.window.showInputBox({ prompt: 'Goal objective' });
      if (!objective) return;
      await client.request('goal/create', { sessionId: id, objective });
    }),
    vscode.commands.registerCommand('hadamard.rememberApproval', async () => {
      const tool = await vscode.window.showInputBox({ prompt: 'Tool name' });
      if (!tool) return;
      await client.request('approval/remember', {
        approval: {
          id: `vscode-${Date.now()}`,
          tool,
          behavior: 'allow',
          createdAt: new Date().toISOString(),
        },
      });
      approvals.refresh();
    }),
  );
  void client.request('initialize').catch(error => {
    void vscode.window.showErrorMessage(`Hadamard app-server: ${String(error)}`);
  });
}

export function deactivate(): void {}
