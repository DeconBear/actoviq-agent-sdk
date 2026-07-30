import * as vscode from 'vscode';
import type { AppServerClient } from './appServerClient.js';

export class ApprovalTreeProvider implements vscode.TreeDataProvider<Record<string, unknown>> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly client: AppServerClient) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(approval: Record<string, unknown>): vscode.TreeItem {
    const item = new vscode.TreeItem(String(approval.tool ?? 'Approval'));
    item.description = String(approval.behavior ?? '');
    return item;
  }

  getChildren(): Promise<Record<string, unknown>[]> {
    return this.client.request<Record<string, unknown>[]>('approval/list');
  }
}

export async function restoreCheckpoint(
  client: AppServerClient,
  sessionId: string,
): Promise<void> {
  const checkpoints = await client.request<Array<{ id: string; createdAt?: string }>>(
    'checkpoint/list',
    { sessionId },
  );
  const selected = await vscode.window.showQuickPick(
    checkpoints.map(item => ({
      label: item.id,
      description: item.createdAt,
      checkpointId: item.id,
    })),
    { placeHolder: 'Choose a checkpoint to preview and restore' },
  );
  if (!selected) return;
  const preview = await client.request<{
    files: Array<{ path: string }>;
    conflicts: unknown[];
  }>('checkpoint/preview', { sessionId, checkpointId: selected.checkpointId });
  const confirmed = await vscode.window.showWarningMessage(
    `Restore ${preview.files.length} file(s) from ${selected.checkpointId}? `
      + `${preview.conflicts.length} conflict(s) were detected.`,
    { modal: true },
    'Restore',
  );
  if (confirmed !== 'Restore') return;
  await client.request('checkpoint/restore', {
    sessionId,
    checkpointId: selected.checkpointId,
    mode: 'both',
    confirm: true,
  });
}
