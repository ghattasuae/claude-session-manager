import * as path from 'path';

/**
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-cwd>/ where the
 * encoded name is the cwd with every path separator replaced by "-".
 * Example: /Users/me/Desktop/app -> -Users-me-Desktop-app
 */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[\\/]/g, '-');
}

/**
 * Best-effort reverse of encodeCwd. Ambiguous when the real path contains "-",
 * so callers should prefer the cwd recorded inside the transcript and only use
 * this as a fallback.
 */
export function decodeFolderName(name: string): string {
  if (!name.startsWith('-')) {
    return name;
  }
  return name.replace(/-/g, '/');
}

/**
 * True when `cwd` belongs to the project folder `folder`. Compared loosely
 * (every non-alphanumeric character treated as "-") so it also holds if Claude
 * encodes characters such as "." or "_" the same way as "/".
 */
export function encodedMatches(cwd: string, folder: string): boolean {
  const loose = (v: string) => v.replace(/[^A-Za-z0-9]/g, '-');
  return loose(encodeCwd(cwd)) === loose(folder);
}

/** Folder in ~/.claude/projects that holds transcripts started in `cwd`. */
export function projectFolderFor(projectsDir: string, cwd: string): string {
  return path.join(projectsDir, encodeCwd(cwd));
}
