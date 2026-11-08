import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { CustomTerminal } from './store';
import { isValidSessionId, stripControl, truncate } from './util';

const TERMINAL_NAME_MAX = 60;

/** POSIX single-quote a value: ' becomes '\'' (works in zsh, bash, sh and fish). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Leave simple paths/names bare so "~/bin/claude" still expands; quote anything else. */
function quoteExecutable(p: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(p) ? p : shellQuote(p);
}

export interface ResumeCommandOptions {
  claudePath: string;
  sessionId: string;
  alias?: string;
  extraArgs?: string;
  fork?: boolean;
}

/**
 * Build `<claude> --resume '<uuid>' [--name '<alias>'] [--fork-session] [extraArgs]`.
 * Throws when the session id is not a UUID so nothing unexpected reaches the shell.
 */
export function buildResumeCommand(opts: ResumeCommandOptions): string {
  if (!isValidSessionId(opts.sessionId)) {
    throw new Error('Invalid session id');
  }
  const exe = stripControl(opts.claudePath).trim() || 'claude';
  const parts = [quoteExecutable(exe), '--resume', shellQuote(opts.sessionId)];
  const alias = opts.alias ? stripControl(opts.alias).trim() : '';
  if (alias) {
    parts.push('--name', shellQuote(alias));
  }
  if (opts.fork) {
    parts.push('--fork-session');
  }
  // extraArgs is the user's own setting and is appended verbatim, minus line breaks.
  const extra = opts.extraArgs ? stripControl(opts.extraArgs).trim() : '';
  if (extra) {
    parts.push(extra);
  }
  return parts.join(' ');
}

export function terminalName(title: string): string {
  return truncate(stripControl(title).trim() || 'Claude', TERMINAL_NAME_MAX);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the folder to open in, offering the home folder when it no longer exists. */
async function resolveCwd(cwd: string): Promise<string | undefined> {
  if (await isDirectory(cwd)) {
    return cwd;
  }
  const choice = await vscode.window.showWarningMessage(
    `The folder ${cwd} no longer exists.`,
    'Open in Home Folder',
  );
  return choice ? os.homedir() : undefined;
}

export interface SessionOpenRequest {
  id: string;
  cwd: string;
  title: string;
  alias?: string;
}

export interface OpenOptions {
  fork?: boolean;
  /** Session is in the live registry but not in a terminal this extension opened. */
  liveElsewhere?: boolean;
  preserveFocus?: boolean;
}

/** Opens and tracks terminals created by the extension. */
export class TerminalManager implements vscode.Disposable {
  readonly sessionTerminals = new Map<string, vscode.Terminal>();
  readonly customTerminals = new Map<string, vscode.Terminal>();

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        let removed = false;
        for (const map of [this.sessionTerminals, this.customTerminals]) {
          for (const [key, t] of map) {
            if (t === closed) {
              map.delete(key);
              removed = true;
            }
          }
        }
        if (removed) {
          this.changed.fire();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  isSessionOpen(id: string): boolean {
    const t = this.sessionTerminals.get(id);
    return !!t && t.exitStatus === undefined;
  }

  isCustomOpen(id: string): boolean {
    const t = this.customTerminals.get(id);
    return !!t && t.exitStatus === undefined;
  }

  /** Returns true when a terminal was created or focused. */
  async openSession(session: SessionOpenRequest, options: OpenOptions = {}): Promise<boolean> {
    if (!isValidSessionId(session.id)) {
      void vscode.window.showErrorMessage('This session id is not valid, so it was not opened.');
      return false;
    }
    if (!options.fork) {
      const existing = this.sessionTerminals.get(session.id);
      if (existing && existing.exitStatus === undefined) {
        existing.show(options.preserveFocus);
        return true;
      }
      if (options.liveElsewhere) {
        void vscode.window.showInformationMessage('This session is already running elsewhere');
      }
    }

    const cwd = await resolveCwd(session.cwd);
    if (!cwd) {
      return false;
    }
    const config = vscode.workspace.getConfiguration('claudeSessions');
    let command: string;
    try {
      command = buildResumeCommand({
        claudePath: config.get<string>('claudePath', 'claude'),
        sessionId: session.id,
        alias: session.alias,
        extraArgs: config.get<string>('extraArgs', ''),
        fork: options.fork,
      });
    } catch {
      return false;
    }
    const name = terminalName(options.fork ? `${session.title} (fork)` : session.title);
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      iconPath: new vscode.ThemeIcon(options.fork ? 'repo-forked' : 'comment-discussion'),
    });
    if (!options.fork) {
      this.sessionTerminals.set(session.id, terminal);
    }
    terminal.sendText(command, true);
    terminal.show(options.preserveFocus);
    this.changed.fire();
    return true;
  }

  async openCustom(entry: CustomTerminal, options: { preserveFocus?: boolean } = {}): Promise<boolean> {
    const existing = this.customTerminals.get(entry.id);
    if (existing && existing.exitStatus === undefined) {
      existing.show(options.preserveFocus);
      return true;
    }
    const cwd = await resolveCwd(entry.cwd);
    if (!cwd) {
      return false;
    }
    const terminal = vscode.window.createTerminal({
      name: terminalName(entry.name),
      cwd,
      iconPath: new vscode.ThemeIcon('terminal'),
    });
    this.customTerminals.set(entry.id, terminal);
    // The custom command is the user's own input and is sent verbatim.
    if (entry.command.trim()) {
      terminal.sendText(entry.command, true);
    }
    terminal.show(options.preserveFocus);
    this.changed.fire();
    return true;
  }

  /**
   * After a window reload VS Code may revive terminals; re-attach custom ones by
   * exact name so they are not opened twice.
   */
  adoptCustomTerminals(entries: CustomTerminal[]): void {
    let adopted = false;
    for (const entry of entries) {
      if (this.isCustomOpen(entry.id)) {
        continue;
      }
      const name = terminalName(entry.name);
      const match = vscode.window.terminals.find(
        (t) => t.name === name && t.exitStatus === undefined && ![...this.customTerminals.values()].includes(t),
      );
      if (match) {
        this.customTerminals.set(entry.id, match);
        adopted = true;
      }
    }
    if (adopted) {
      this.changed.fire();
    }
  }
}
