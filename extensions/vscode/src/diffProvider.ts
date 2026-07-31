import * as vscode from 'vscode';
import type { AppServerClient } from './appServerClient.js';

export async function showSessionDiff(client: AppServerClient, sessionId: string): Promise<void> {
  const diff = await client.request<{ patch: string }>('diff/get', { sessionId });
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: diff.patch || 'No changes.',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

export async function applySessionDiff(client: AppServerClient, sessionId: string): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Apply this Session diff to the workspace?',
    { modal: true },
    'Apply',
  );
  if (confirmed !== 'Apply') return;
  await client.request('diff/apply', { sessionId, confirm: true });
  void vscode.window.showInformationMessage('Hadamard Session diff applied.');
}
