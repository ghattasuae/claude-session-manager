import * as vscode from 'vscode';
import { isValidSessionId } from './util';

export interface CustomTerminal {
  id: string;
  name: string;
  cwd: string;
  command: string;
  /** Include this terminal when the last layout is restored. */
  autoRestore: boolean;
}

export interface Layout {
  savedAt: number;
  sessions: string[];
  customTerminals: string[];
}

const KEY_ALIASES = 'aliases';
const KEY_CUSTOM = 'customTerminals';
const KEY_HIDDEN = 'hiddenSessions';
const KEY_LAYOUT = 'lastLayout';

/** Typed wrapper over VS Code extension state. Never touches ~/.claude. */
export class Store {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // ---- aliases (globalState) ----

  getAliases(): Record<string, string> {
    const raw = this.context.globalState.get<unknown>(KEY_ALIASES);
    const out: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (isValidSessionId(k) && typeof v === 'string' && v) {
          out[k] = v;
        }
      }
    }
    return out;
  }

  getAlias(sessionId: string): string | undefined {
    return this.getAliases()[sessionId];
  }

  async setAlias(sessionId: string, alias: string | undefined): Promise<void> {
    const aliases = this.getAliases();
    if (alias) {
      aliases[sessionId] = alias;
    } else {
      delete aliases[sessionId];
    }
    await this.context.globalState.update(KEY_ALIASES, aliases);
  }

  // ---- custom terminals (globalState) ----

  getCustomTerminals(): CustomTerminal[] {
    const raw = this.context.globalState.get<unknown>(KEY_CUSTOM);
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: CustomTerminal[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const r = item as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.cwd !== 'string') {
        continue;
      }
      out.push({
        id: r.id,
        name: r.name,
        cwd: r.cwd,
        command: typeof r.command === 'string' ? r.command : '',
        autoRestore: r.autoRestore !== false,
      });
    }
    return out;
  }

  async setCustomTerminals(list: CustomTerminal[]): Promise<void> {
    await this.context.globalState.update(KEY_CUSTOM, list);
  }

  // ---- hidden sessions (globalState) ----

  getHidden(): Set<string> {
    const raw = this.context.globalState.get<unknown>(KEY_HIDDEN);
    return new Set(Array.isArray(raw) ? raw.filter(isValidSessionId) : []);
  }

  async setHidden(sessionId: string, hidden: boolean): Promise<void> {
    const set = this.getHidden();
    if (hidden) {
      set.add(sessionId);
    } else {
      set.delete(sessionId);
    }
    await this.context.globalState.update(KEY_HIDDEN, [...set]);
  }

  // ---- last layout (workspaceState when a workspace is open, else globalState) ----

  private layoutMemento(): vscode.Memento {
    return vscode.workspace.workspaceFolders?.length ? this.context.workspaceState : this.context.globalState;
  }

  getLayout(): Layout | undefined {
    const raw = this.layoutMemento().get<unknown>(KEY_LAYOUT);
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const r = raw as Record<string, unknown>;
    const sessions = Array.isArray(r.sessions) ? r.sessions.filter(isValidSessionId) : [];
    const customTerminals = Array.isArray(r.customTerminals)
      ? r.customTerminals.filter((x): x is string => typeof x === 'string')
      : [];
    if (sessions.length === 0 && customTerminals.length === 0) {
      return undefined;
    }
    return {
      savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
      sessions,
      customTerminals,
    };
  }

  async setLayout(layout: Layout): Promise<void> {
    await this.layoutMemento().update(KEY_LAYOUT, layout);
  }
}
