import * as vscode from 'vscode';
import { CustomTerminal, Store } from './store';
import { tildify } from './util';

export class CustomTerminalNode {
  readonly kind = 'customTerminal' as const;
  constructor(
    readonly entry: CustomTerminal,
    readonly open: boolean,
  ) {}
}

export class CustomTerminalsProvider implements vscode.TreeDataProvider<CustomTerminalNode> {
  private readonly emitter = new vscode.EventEmitter<CustomTerminalNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: Store,
    private readonly isOpen: (id: string) => boolean,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getChildren(element?: CustomTerminalNode): CustomTerminalNode[] {
    if (element) {
      return [];
    }
    return this.store.getCustomTerminals().map((e) => new CustomTerminalNode(e, this.isOpen(e.id)));
  }

  getTreeItem(element: CustomTerminalNode): vscode.TreeItem {
    const e = element.entry;
    const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None);
    item.id = `custom:${e.id}`;
    item.description = e.command || tildify(e.cwd);
    item.tooltip = [
      e.name,
      element.open ? 'Open now' : '',
      '',
      `Folder: ${e.cwd}`,
      `Command: ${e.command || '(none, plain shell)'}`,
      `Included in layout restore: ${e.autoRestore ? 'yes' : 'no'}`,
    ]
      .filter((line, i) => i !== 1 || line)
      .join('\n');
    item.iconPath = element.open
      ? new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('terminal');
    item.contextValue = 'customTerminal';
    item.command = {
      command: 'claudeSessions.openCustomTerminal',
      title: 'Open Custom Terminal',
      arguments: [element],
    };
    return item;
  }
}
