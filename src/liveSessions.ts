import * as fs from 'fs';
import * as path from 'path';
import { isValidSessionId } from './util';

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  startedAt?: number;
  kind?: string;
}

/** True when a process with this pid exists (EPERM still means it exists). */
export function isPidAlive(pid: number): boolean {
  // pid 0 / negative values would address process groups; 1 is init.
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the Claude Code live session registry (~/.claude/sessions/<pid>.json).
 * Stale files left behind by crashes are filtered out with a pid liveness check.
 * Returns a map keyed by sessionId.
 */
export async function readLiveSessions(sessionsDir: string): Promise<Map<string, LiveSession>> {
  const result = new Map<string, LiveSession>();
  let names: string[];
  try {
    names = await fs.promises.readdir(sessionsDir);
  } catch {
    return result;
  }
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const raw = await fs.promises.readFile(path.join(sessionsDir, n), 'utf8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          const pid = typeof data.pid === 'number' ? data.pid : Number(n.slice(0, -5));
          const sessionId = data.sessionId;
          if (!isValidSessionId(sessionId) || !isPidAlive(pid)) {
            return;
          }
          const entry: LiveSession = {
            pid,
            sessionId,
            cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
            name: typeof data.name === 'string' ? data.name : undefined,
            status: typeof data.status === 'string' ? data.status : undefined,
            startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
            kind: typeof data.kind === 'string' ? data.kind : undefined,
          };
          const prev = result.get(sessionId);
          if (!prev || (entry.startedAt ?? 0) > (prev.startedAt ?? 0)) {
            result.set(sessionId, entry);
          }
        } catch {
          // Malformed or vanished file: ignore.
        }
      }),
  );
  return result;
}

export function sameLiveSet(a: Map<string, LiveSession>, b: Map<string, LiveSession>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, v] of a) {
    const o = b.get(id);
    if (!o || o.pid !== v.pid || o.status !== v.status) {
      return false;
    }
  }
  return true;
}
