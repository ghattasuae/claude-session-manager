import * as os from 'os';
import * as path from 'path';

/** Claude session ids are lowercase UUIDs. Anything else is never sent to a shell. */
export const SESSION_ID_RE = /^[0-9a-f-]{36}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** Expand a leading "~" to the user's home folder. */
export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Replace the home folder prefix with "~" for display. */
export function tildify(p: string): string {
  const home = os.homedir();
  if (p === home) {
    return '~';
  }
  if (p.startsWith(home + path.sep)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/** True when `child` equals `parent` or is inside it. */
export function isUnder(child: string | undefined, parent: string): boolean {
  if (!child) {
    return false;
  }
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) {
    return true;
  }
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Remove control characters (including newlines) so text cannot break out of a shell line. */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "just now", "5m ago", "2h ago", "3d ago", then a short date. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
  );
}
