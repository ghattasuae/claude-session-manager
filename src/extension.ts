import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CustomTerminalNode, CustomTerminalsProvider } from './customTerminalsView';
import { LiveSession, readLiveSessions, sameLiveSet } from './liveSessions';
import { displayTitle, SessionInfo, SessionScanner } from './sessionScanner';
import { ProjectNode, SessionNode, SessionsProvider } from './sessionsView';
import { CustomTerminal, Layout, Store } from './store';
import { TerminalManager } from './terminals';
import { delay, expandHome, isUnder, isValidSessionId, plural, relativeTime, stripControl, tildify } from './util';

const POLL_MS = 5000;
const WATCH_DEBOUNCE_MS = 1500;
const TERMINAL_EVENT_DEBOUNCE_MS = 1000;
const RESTORE_STAGGER_MS = 400;
const RESTORE_PROMPT_HOLD_MS = 120_000;

class Controller implements vscode.Disposable {
  private readonly store: Store;
  private readonly scanner = new SessionScanner();
  private readonly terminals = new TerminalManager();
  private readonly sessionsProvider: SessionsProvider;
  private readonly customProvider: CustomTerminalsProvider;
  private readonly sessionsTree: vscode.TreeView<SessionNode | ProjectNode>;
  private readonly customTree: vscode.TreeView<CustomTerminalNode>;
  private readonly disposables: vscode.Disposable[] = [];

  private sessions: SessionInfo[] = [];
  private sessionsById = new Map<string, SessionInfo>();
  private live = new Map<string, LiveSession>();
  private loaded = false;
  private showHidden = false;
  private disposed = false;

  private scanning: Promise<void> | undefined;
  private rescanQueued = false;
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private terminalEventTimer: NodeJS.Timeout | undefined;
  private restoring = false;
  private restorePromptPending = false;

  constructor(context: vscode.ExtensionContext) {
    this.store = new Store(context);
    const self = this;
    this.sessionsProvider = new SessionsProvider({
      getSessions: () => self.sessions,
      getLive: () => self.live,
      store: self.store,
      isShowingHidden: () => self.showHidden,
      isLoaded: () => self.loaded,
    });
    this.customProvider = new CustomTerminalsProvider(this.store, (id) => this.terminals.isCustomOpen(id));
    this.sessionsTree = vscode.window.createTreeView('claudeSessions', {
      treeDataProvider: this.sessionsProvider,
      showCollapseAll: true,
    });
    this.customTree = vscode.window.createTreeView('claudeCustomTerminals', {
      treeDataProvider: this.customProvider,
    });
    this.disposables.push(this.sessionsTree, this.customTree, this.terminals, this.sessionsProvider, this.customProvider);
  }

  // ---------------------------------------------------------------- paths

  private projectsDir(): string {
    const configured = vscode.workspace.getConfiguration('claudeSessions').get<string>('projectsDir', '~/.claude/projects');
    return path.resolve(expandHome((configured || '~/.claude/projects').trim()));
  }

  /** ~/.claude/sessions sits next to ~/.claude/projects. */
  private liveDir(): string {
    return path.join(path.dirname(this.projectsDir()), 'sessions');
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    void vscode.commands.executeCommand('setContext', 'claudeSessions.showHidden', false);
    this.registerCommands();

    this.disposables.push(
      this.sessionsTree.onDidChangeVisibility((e) => {
        if (e.visible) {
          void this.rescan();
          void this.pollLive();
        }
      }),
      this.terminals.onDidChange(() => this.customProvider.refresh()),
      vscode.window.onDidOpenTerminal(() => this.onTerminalEvent()),
      vscode.window.onDidCloseTerminal(() => this.onTerminalEvent()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.sessionsProvider.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChange(e)),
    );

    this.startWatcher();
    this.terminals.adoptCustomTerminals(this.store.getCustomTerminals());
    await Promise.all([this.rescan(), this.pollLive()]);

    this.pollTimer = setInterval(() => void this.tick(), POLL_MS);
    void this.maybeAutoRestore();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    if (this.terminalEventTimer) {
      clearTimeout(this.terminalEventTimer);
    }
    this.stopWatcher();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('claudeSessions.projectsDir')) {
      this.stopWatcher();
      this.scanner.clearCache();
      this.startWatcher();
      void this.rescan();
      void this.pollLive();
      return;
    }
    if (
      e.affectsConfiguration('claudeSessions.currentWorkspaceOnly') ||
      e.affectsConfiguration('claudeSessions.maxSessionsPerProject')
    ) {
      this.sessionsProvider.refresh();
    }
  }

  // ---------------------------------------------------------------- scanning

  private startWatcher(): void {
    if (this.watcher) {
      return;
    }
    try {
      this.watcher = fs.watch(this.projectsDir(), { recursive: true, persistent: false }, (_event, filename) => {
        if (filename && !String(filename).endsWith('.jsonl')) {
          return;
        }
        this.scheduleRescan();
      });
      this.watcher.on('error', () => this.stopWatcher());
    } catch {
      this.watcher = undefined;
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = undefined;
    }
  }

  private scheduleRescan(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      // Hidden view: skip; it rescans when it becomes visible again.
      if (this.sessionsTree.visible) {
        void this.rescan();
      }
    }, WATCH_DEBOUNCE_MS);
  }

  /** Rescan transcripts. Concurrent calls collapse into one follow-up scan. */
  private rescan(): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      do {
        this.rescanQueued = false;
        // The folder may have been created since activation.
        this.startWatcher();
        const result = await this.scanner.scan(this.projectsDir());
        if (this.disposed) {
          return;
        }
        // Sessions whose cwd was only decoded from the folder name borrow a real cwd
        // from a sibling transcript in the same project folder.
        const realCwd = new Map<string, string>();
        for (const s of result.sessions) {
          if (s.cwdFromTranscript && !realCwd.has(s.folder)) {
            realCwd.set(s.folder, s.cwd);
          }
        }
        for (const s of result.sessions) {
          const cwd = realCwd.get(s.folder);
          if (!s.cwdFromTranscript && cwd) {
            s.cwd = cwd;
          }
        }
        this.sessions = result.sessions;
        this.sessionsById = new Map(result.sessions.map((s) => [s.id, s]));
        this.loaded = true;
        this.sessionsTree.message = result.error;
        this.sessionsProvider.refresh();
      } while (this.rescanQueued && !this.disposed);
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async pollLive(): Promise<void> {
    const next = await readLiveSessions(this.liveDir());
    if (this.disposed) {
      return;
    }
    const changed = !sameLiveSet(next, this.live);
    this.live = next;
    if (changed) {
      this.sessionsProvider.refresh();
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed) {
      return;
    }
    // The registry is tiny; reading it always keeps the layout snapshot accurate.
    // The tree only repaints when visible (VS Code ignores refreshes of hidden views).
    await this.pollLive();
    // A terminal opened or closed in the last second: let the debounced handler
    // snapshot once things settle, so a shutdown burst cannot shrink the layout.
    if (this.terminalEventTimer) {
      return;
    }
    await this.snapshotLayout();
  }

  private onTerminalEvent(): void {
    if (this.terminalEventTimer) {
      clearTimeout(this.terminalEventTimer);
    }
    // Debounced so a window shutdown (which closes every terminal at once) ends
    // the extension host before a shrunken layout could be written.
    this.terminalEventTimer = setTimeout(() => {
      this.terminalEventTimer = undefined;
      void this.pollLive().then(() => this.snapshotLayout());
    }, TERMINAL_EVENT_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- layout

  private currentLayout(): Layout {
    const wsFolders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => f.uri.fsPath);
    const sessions = new Set<string>();
    for (const id of this.terminals.sessionTerminals.keys()) {
      if (this.terminals.isSessionOpen(id)) {
        sessions.add(id);
      }
    }
    for (const entry of this.live.values()) {
      if (this.terminals.isSessionOpen(entry.sessionId) || wsFolders.some((f) => isUnder(entry.cwd, f))) {
        sessions.add(entry.sessionId);
      }
    }
    const customTerminals = [...this.terminals.customTerminals.keys()].filter((id) => this.terminals.isCustomOpen(id));
    return { savedAt: Date.now(), sessions: [...sessions].sort(), customTerminals: customTerminals.sort() };
  }

  private async snapshotLayout(): Promise<void> {
    if (this.disposed || this.restoring || this.restorePromptPending) {
      return;
    }
    const layout = this.currentLayout();
    // Never overwrite the last good layout with an empty one (e.g. while closing).
    if (layout.sessions.length + layout.customTerminals.length === 0) {
      return;
    }
    const prev = this.store.getLayout();
    if (
      prev &&
      prev.sessions.join(',') === layout.sessions.join(',') &&
      [...prev.customTerminals].sort().join(',') === layout.customTerminals.join(',')
    ) {
      return;
    }
    await this.store.setLayout(layout);
  }

  /** Items of a layout that exist and are not open right now. */
  private restorableItems(layout: Layout): { sessions: SessionInfo[]; customs: CustomTerminal[] } {
    const sessions: SessionInfo[] = [];
    for (const id of layout.sessions) {
      const s = this.sessionsById.get(id);
      if (s && !this.terminals.isSessionOpen(id) && !this.live.has(id)) {
        sessions.push(s);
      }
    }
    const all = this.store.getCustomTerminals();
    const customs = layout.customTerminals
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is CustomTerminal => !!c && c.autoRestore && !this.terminals.isCustomOpen(c.id));
    return { sessions, customs };
  }

  private async restoreLayout(layout: Layout | undefined = this.store.getLayout()): Promise<void> {
    if (!layout) {
      void vscode.window.showInformationMessage('No saved layout yet. Open some sessions or custom terminals first.');
      return;
    }
    if (this.restoring) {
      return;
    }
    this.restoring = true;
    let sessionsOpened = 0;
    let terminalsOpened = 0;
    try {
      await this.rescan();
      await this.pollLive();
      const { sessions, customs } = this.restorableItems(layout);
      let first = true;
      for (const s of sessions) {
        if (!first) {
          await delay(RESTORE_STAGGER_MS);
        }
        first = false;
        const alias = this.store.getAlias(s.id);
        const ok = await this.terminals.openSession(
          { id: s.id, cwd: s.cwd, title: displayTitle(s, alias), alias },
          { preserveFocus: true },
        );
        if (ok) {
          sessionsOpened++;
        }
      }
      for (const c of customs) {
        if (!first) {
          await delay(RESTORE_STAGGER_MS);
        }
        first = false;
        if (await this.terminals.openCustom(c, { preserveFocus: true })) {
          terminalsOpened++;
        }
      }
    } finally {
      this.restoring = false;
    }
    void vscode.window.showInformationMessage(
      sessionsOpened + terminalsOpened === 0
        ? 'Everything from the last layout is already open'
        : `Restored ${plural(sessionsOpened, 'session')} and ${plural(terminalsOpened, 'terminal')}`,
    );
    await this.snapshotLayout();
  }

  private async maybeAutoRestore(): Promise<void> {
    const mode = vscode.workspace.getConfiguration('claudeSessions').get<string>('autoRestore', 'prompt');
    if (mode !== 'prompt' && mode !== 'always') {
      return;
    }
    const layout = this.store.getLayout();
    if (!layout) {
      return;
    }
    const anyOpen =
      layout.sessions.some((id) => this.live.has(id) || this.terminals.isSessionOpen(id)) ||
      layout.customTerminals.some((id) => this.terminals.isCustomOpen(id));
    if (anyOpen) {
      return;
    }
    const { sessions, customs } = this.restorableItems(layout);
    if (sessions.length + customs.length === 0) {
      return;
    }
    if (mode === 'always') {
      await this.restoreLayout(layout);
      return;
    }
    // Hold snapshots while the question is open so the saved layout is not replaced
    // underneath it. Released after an answer or a time limit.
    this.restorePromptPending = true;
    const release = setTimeout(() => {
      this.restorePromptPending = false;
    }, RESTORE_PROMPT_HOLD_MS);
    let choice: string | undefined;
    try {
      choice = await vscode.window.showInformationMessage(
        `Restore your last Claude layout (${plural(sessions.length, 'session')} and ${plural(customs.length, 'terminal')}, saved ${relativeTime(layout.savedAt) || 'earlier'})?`,
        'Restore',
      );
    } finally {
      clearTimeout(release);
      this.restorePromptPending = false;
    }
    if (choice === 'Restore') {
      await this.restoreLayout(layout);
    }
  }

  // ---------------------------------------------------------------- helpers

  private sessionFromArg(arg: unknown): SessionNode | undefined {
    if (arg instanceof SessionNode) {
      return arg;
    }
    const selected = this.sessionsTree.selection[0];
    return selected instanceof SessionNode ? selected : undefined;
  }

  private async pickSession(placeHolder: string): Promise<SessionNode | undefined> {
    if (!this.loaded) {
      await this.rescan();
    }
    type Item = vscode.QuickPickItem & { node: SessionNode };
    const items: Item[] = this.sessionsProvider.visibleSessions().map((s) => {
      const node = this.sessionsProvider.makeSessionNode(s);
      return {
        label: `${node.live ? '$(circle-filled) ' : ''}${node.title}`,
        description: `${path.basename(s.cwd)} · ${relativeTime(s.modified)}`,
        detail: [s.firstPrompt, tildify(s.cwd)].filter(Boolean).join('  ·  '),
        node,
      };
    });
    if (items.length === 0) {
      void vscode.window.showInformationMessage('No Claude sessions found.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked?.node;
  }

  private async sessionOrPick(arg: unknown, placeHolder: string): Promise<SessionNode | undefined> {
    return this.sessionFromArg(arg) ?? (await this.pickSession(placeHolder));
  }

  private async openSessionNode(node: SessionNode, fork = false): Promise<void> {
    const s = node.session;
    const alias = this.store.getAlias(s.id);
    const title = displayTitle(s, alias);
    await this.terminals.openSession(
      { id: s.id, cwd: s.cwd, title, alias },
      { fork, liveElsewhere: !fork && this.live.has(s.id) && !this.terminals.isSessionOpen(s.id) },
    );
  }

  private customFromArg(arg: unknown): CustomTerminal | undefined {
    let id: string | undefined;
    if (arg instanceof CustomTerminalNode) {
      id = arg.entry.id;
    } else {
      const selected = this.customTree.selection[0];
      id = selected?.entry.id;
    }
    return id ? this.store.getCustomTerminals().find((c) => c.id === id) : undefined;
  }

  /** Name, folder, command. Returns undefined when cancelled. */
  private async promptCustomTerminal(initial?: CustomTerminal): Promise<Omit<CustomTerminal, 'id'> | undefined> {
    const name = await vscode.window.showInputBox({
      title: initial ? 'Edit Custom Terminal (1/3)' : 'Add Custom Terminal (1/3)',
      prompt: 'Terminal name',
      placeHolder: 'Dev server',
      value: initial?.name,
      validateInput: (v) => (stripControl(v).trim() ? undefined : 'Enter a name'),
    });
    if (name === undefined) {
      return undefined;
    }

    const defaultFolder =
      initial?.cwd ??
      vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath ??
      os.homedir();
    const folders = await vscode.window.showOpenDialog({
      title: initial ? 'Edit Custom Terminal (2/3): choose the folder' : 'Add Custom Terminal (2/3): choose the folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultFolder),
      openLabel: 'Use This Folder',
    });
    let cwd: string;
    if (folders && folders[0]) {
      cwd = folders[0].fsPath;
    } else if (initial) {
      cwd = initial.cwd; // cancelling the folder step while editing keeps the old folder
    } else {
      return undefined;
    }

    const command = await vscode.window.showInputBox({
      title: initial ? 'Edit Custom Terminal (3/3)' : 'Add Custom Terminal (3/3)',
      prompt: `Command to run in ${tildify(cwd)} (leave empty for a plain shell)`,
      placeHolder: 'npm run dev:local',
      value: initial?.command,
    });
    if (command === undefined) {
      return undefined;
    }
    return {
      name: stripControl(name).trim(),
      cwd,
      command: stripControl(command).trim(),
      autoRestore: initial?.autoRestore ?? true,
    };
  }

  private async updateCustomTerminals(mutate: (list: CustomTerminal[]) => CustomTerminal[]): Promise<void> {
    await this.store.setCustomTerminals(mutate(this.store.getCustomTerminals()));
    this.customProvider.refresh();
  }

  private async moveCustom(arg: unknown, delta: number): Promise<void> {
    const entry = this.customFromArg(arg);
    if (!entry) {
      return;
    }
    await this.updateCustomTerminals((list) => {
      const i = list.findIndex((c) => c.id === entry.id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) {
        return list;
      }
      [list[i], list[j]] = [list[j], list[i]];
      return list;
    });
  }

  // ---------------------------------------------------------------- commands

  private registerCommands(): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));

    reg('claudeSessions.refresh', async () => {
      await Promise.all([this.rescan(), this.pollLive()]);
      this.customProvider.refresh();
    });

    reg('claudeSessions.search', async () => {
      const node = await this.pickSession('Search sessions by title, first prompt or project');
      if (node) {
        await this.openSessionNode(node);
      }
    });

    reg('claudeSessions.restoreLayout', () => this.restoreLayout());

    const setWorkspaceOnly = async (value: boolean) => {
      await vscode.workspace
        .getConfiguration('claudeSessions')
        .update('currentWorkspaceOnly', value, vscode.ConfigurationTarget.Global);
    };
    reg('claudeSessions.toggleWorkspaceOnly', () => setWorkspaceOnly(true));
    reg('claudeSessions.toggleWorkspaceOnlyOff', () => setWorkspaceOnly(false));

    const setShowHidden = async (value: boolean) => {
      this.showHidden = value;
      await vscode.commands.executeCommand('setContext', 'claudeSessions.showHidden', value);
      this.sessionsProvider.refresh();
    };
    reg('claudeSessions.showHidden', () => setShowHidden(true));
    reg('claudeSessions.hideHidden', () => setShowHidden(false));

    reg('claudeSessions.open', async (arg) => {
      const node = await this.sessionOrPick(arg, 'Open which session?');
      if (node) {
        await this.openSessionNode(node);
      }
    });

    reg('claudeSessions.fork', async (arg) => {
      const node = await this.sessionOrPick(arg, 'Fork which session?');
      if (node) {
        await this.openSessionNode(node, true);
      }
    });

    reg('claudeSessions.rename', async (arg) => {
      const node = await this.sessionOrPick(arg, 'Rename which session?');
      if (!node) {
        return;
      }
      const s = node.session;
      const current = displayTitle(s, this.store.getAlias(s.id));
      const value = await vscode.window.showInputBox({
        title: 'Rename Session',
        prompt: 'New name for this session. Leave empty to clear your custom name.',
        value: current,
        valueSelection: [0, current.length],
      });
      if (value === undefined) {
        return;
      }
      const alias = stripControl(value).replace(/\s+/g, ' ').trim().slice(0, 200);
      await this.store.setAlias(s.id, alias || undefined);
      this.sessionsProvider.refresh();
    });

    reg('claudeSessions.copyId', async (arg) => {
      const node = this.sessionFromArg(arg);
      if (node) {
        await vscode.env.clipboard.writeText(node.session.id);
        void vscode.window.setStatusBarMessage('Session ID copied', 2000);
      }
    });

    reg('claudeSessions.revealTranscript', async (arg) => {
      const node = this.sessionFromArg(arg);
      if (node) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.session.file));
      }
    });

    reg('claudeSessions.hide', async (arg) => {
      const node = this.sessionFromArg(arg);
      if (node && isValidSessionId(node.session.id)) {
        await this.store.setHidden(node.session.id, true);
        this.sessionsProvider.refresh();
      }
    });

    reg('claudeSessions.unhide', async (arg) => {
      const node = this.sessionFromArg(arg);
      if (node) {
        await this.store.setHidden(node.session.id, false);
        this.sessionsProvider.refresh();
      }
    });

    reg('claudeSessions.addCustomTerminal', async () => {
      const result = await this.promptCustomTerminal();
      if (!result) {
        return;
      }
      await this.updateCustomTerminals((list) => [...list, { id: crypto.randomUUID(), ...result }]);
    });

    reg('claudeSessions.openCustomTerminal', async (arg) => {
      const entry = this.customFromArg(arg);
      if (entry) {
        await this.terminals.openCustom(entry);
      }
    });

    reg('claudeSessions.editCustomTerminal', async (arg) => {
      const entry = this.customFromArg(arg);
      if (!entry) {
        return;
      }
      const result = await this.promptCustomTerminal(entry);
      if (!result) {
        return;
      }
      await this.updateCustomTerminals((list) => list.map((c) => (c.id === entry.id ? { ...c, ...result } : c)));
    });

    reg('claudeSessions.duplicateCustomTerminal', async (arg) => {
      const entry = this.customFromArg(arg);
      if (!entry) {
        return;
      }
      await this.updateCustomTerminals((list) => {
        const i = list.findIndex((c) => c.id === entry.id);
        const copy: CustomTerminal = { ...entry, id: crypto.randomUUID(), name: `${entry.name} (copy)` };
        list.splice(i < 0 ? list.length : i + 1, 0, copy);
        return list;
      });
    });

    reg('claudeSessions.deleteCustomTerminal', async (arg) => {
      const entry = this.customFromArg(arg);
      if (!entry) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete the custom terminal "${entry.name}"?`,
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') {
        return;
      }
      this.terminals.customTerminals.delete(entry.id);
      await this.updateCustomTerminals((list) => list.filter((c) => c.id !== entry.id));
    });

    reg('claudeSessions.moveCustomTerminalUp', (arg) => this.moveCustom(arg, -1));
    reg('claudeSessions.moveCustomTerminalDown', (arg) => this.moveCustom(arg, 1));

    reg('claudeSessions.toggleCustomTerminalAutoRestore', async (arg) => {
      const entry = this.customFromArg(arg);
      if (!entry) {
        return;
      }
      await this.updateCustomTerminals((list) =>
        list.map((c) => (c.id === entry.id ? { ...c, autoRestore: !c.autoRestore } : c)),
      );
      void vscode.window.setStatusBarMessage(
        `${entry.name}: ${entry.autoRestore ? 'not included' : 'included'} in layout restore`,
        3000,
      );
    });
  }
}

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new Controller(context);
  context.subscriptions.push(controller);
  await controller.start();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
