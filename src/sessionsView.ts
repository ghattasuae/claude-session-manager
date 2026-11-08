import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession } from './liveSessions';
import { displayTitle, SessionInfo } from './sessionScanner';
import { Store } from './store';
import { isUnder, relativeTime, tildify } from './util';

export interface SessionsModel {
  getSessions(): SessionInfo[];
  getLive(): Map<string, LiveSession>;
  readonly store: Store;
  isShowingHidden(): boolean;
  isLoaded(): boolean;
}

export class ProjectNode {
  readonly kind = 'project' as const;
  constructor(
    readonly folder: string,
    readonly cwd: string,
    readonly sessions: SessionInfo[],
    readonly isWorkspace: boolean,
    readonly totalCount: number,
  ) {}
}

export class SessionNode {
  readonly kind = 'session' as const;
  constructor(
    readonly session: SessionInfo,
    readonly title: string,
    readonly alias: string | undefined,
    readonly live: boolean,
    readonly hidden: boolean,
  ) {}
}

export type SessionsTreeNode = ProjectNode | SessionNode;

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}

export class SessionsProvider implements vscode.TreeDataProvider<SessionsTreeNode> {
  private readonly emitter = new vscode.EventEmitter<SessionsTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly model: SessionsModel) {}

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** Build a session node for any session (used by search and commands). */
  makeSessionNode(s: SessionInfo): SessionNode {
    const alias = this.model.store.getAlias(s.id);
    return new SessionNode(
      s,
      displayTitle(s, alias),
      alias,
      this.model.getLive().has(s.id),
      this.model.store.getHidden().has(s.id),
    );
  }

  /** Sessions after hidden filtering, newest first. */
  visibleSessions(): SessionInfo[] {
    const hidden = this.model.store.getHidden();
    const showHidden = this.model.isShowingHidden();
    return this.model
      .getSessions()
      .filter((s) => showHidden || !hidden.has(s.id))
      .sort((a, b) => b.modified - a.modified);
  }

  getProjects(): ProjectNode[] {
    const config = vscode.workspace.getConfiguration('claudeSessions');
    const max = Math.max(1, Math.floor(config.get<number>('maxSessionsPerProject', 50)));
    const workspaceOnly = config.get<boolean>('currentWorkspaceOnly', false);
    const wsFolders = workspaceFolderPaths();

    const groups = new Map<string, SessionInfo[]>();
    for (const s of this.visibleSessions()) {
      const list = groups.get(s.folder);
      if (list) {
        list.push(s);
      } else {
        groups.set(s.folder, [s]);
      }
    }

    const projects: ProjectNode[] = [];
    for (const [folder, sessions] of groups) {
      // sessions are already newest first; prefer a cwd that came from a transcript.
      const cwd = (sessions.find((s) => s.cwdFromTranscript) ?? sessions[0]).cwd;
      const isWorkspace = wsFolders.some((f) => isUnder(cwd, f));
      if (workspaceOnly && wsFolders.length > 0 && !isWorkspace) {
        continue;
      }
      projects.push(new ProjectNode(folder, cwd, sessions.slice(0, max), isWorkspace, sessions.length));
    }

    projects.sort((a, b) => {
      if (a.isWorkspace !== b.isWorkspace) {
        return a.isWorkspace ? -1 : 1;
      }
      return (b.sessions[0]?.modified ?? 0) - (a.sessions[0]?.modified ?? 0);
    });
    return projects;
  }

  getChildren(element?: SessionsTreeNode): SessionsTreeNode[] {
    if (!element) {
      if (!this.model.isLoaded()) {
        return [];
      }
      return this.getProjects();
    }
    if (element.kind === 'project') {
      return element.sessions.map((s) => this.makeSessionNode(s));
    }
    return [];
  }

  getTreeItem(element: SessionsTreeNode): vscode.TreeItem {
    if (element.kind === 'project') {
      const label = path.basename(element.cwd) || element.cwd;
      const item = new vscode.TreeItem(
        label,
        element.isWorkspace ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `project:${element.folder}:${element.isWorkspace ? 'ws' : 'other'}`;
      item.description = tildify(element.cwd);
      const shown =
        element.totalCount > element.sessions.length
          ? `${element.sessions.length} of ${element.totalCount} sessions`
          : `${element.totalCount} session${element.totalCount === 1 ? '' : 's'}`;
      item.tooltip = `${element.cwd}\n${shown}`;
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'project';
      return item;
    }

    const s = element.session;
    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${s.id}`;
    const descParts = [relativeTime(s.modified)];
    if (s.gitBranch) {
      descParts.push(s.gitBranch);
    }
    if (element.hidden) {
      descParts.push('hidden');
    }
    item.description = descParts.filter(Boolean).join(' · ');

    const tip: string[] = [element.title];
    if (element.live) {
      tip.push('Running now');
    }
    if (s.firstPrompt && s.firstPrompt !== element.title) {
      tip.push('', `First prompt: ${s.firstPrompt}`);
    }
    tip.push('', `Folder: ${s.cwd}`);
    if (s.gitBranch) {
      tip.push(`Branch: ${s.gitBranch}`);
    }
    tip.push(`Modified: ${new Date(s.modified).toLocaleString()}`);
    tip.push(`Created: ${new Date(s.created).toLocaleString()}`);
    tip.push(`Session ID: ${s.id}`);
    item.tooltip = tip.join('\n');

    item.iconPath = element.live
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('history');
    item.contextValue = element.hidden ? 'sessionHidden' : element.live ? 'sessionLive' : 'session';
    item.command = {
      command: 'claudeSessions.open',
      title: 'Open Session',
      arguments: [element],
    };
    return item;
  }
}
