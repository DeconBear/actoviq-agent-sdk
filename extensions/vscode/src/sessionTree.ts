import * as vscode from 'vscode';
import type { AppServerClient } from './appServerClient.js';

interface SessionGraphNode {
  session: {
    id: string;
    title: string;
    status?: string;
    messages?: unknown[];
  };
  children: SessionGraphNode[];
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionGraphNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly client: AppServerClient) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: SessionGraphNode): vscode.TreeItem {
    const session = node.session;
    const item = new vscode.TreeItem(
      session.title,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${session.status ?? 'active'} · ${session.messages?.length ?? 0}`;
    item.command = {
      command: 'actoviq.openSession',
      title: 'Open Session',
      arguments: [session.id],
    };
    return item;
  }

  getChildren(node?: SessionGraphNode): Promise<SessionGraphNode[]> | SessionGraphNode[] {
    if (node) return node.children;
    return this.client.request<SessionGraphNode[]>('session/tree');
  }
}
