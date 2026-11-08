import * as fs from 'fs';
import * as path from 'path';
import { decodeFolderName, encodedMatches } from './encodePath';
import { isValidSessionId } from './util';

export interface SessionInfo {
  id: string;
  /** Absolute path of the .jsonl transcript. */
  file: string;
  /** Name of the folder inside the projects dir (encoded cwd). */
  folder: string;
  /** Working directory the session was started in. */
  cwd: string;
  /** False when cwd was decoded from the folder name (may be inaccurate). */
  cwdFromTranscript: boolean;
  gitBranch?: string;
  firstPrompt?: string;
  aiTitle?: string;
  customTitle?: string;
  created: number;
  modified: number;
  size: number;
}

export interface ScanResult {
  sessions: SessionInfo[];
  /** Set when the projects folder could not be read (missing folder is not an error). */
  error?: string;
}

const CHUNK = 64 * 1024;
const MIN_SIZE = 200;
const PROMPT_MAX = 120;
const MAX_PARALLEL = 16;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  info: SessionInfo | null;
}

/** Display priority: extension alias > customTitle > aiTitle > first prompt > id prefix. */
export function displayTitle(s: SessionInfo, alias?: string): string {
  return alias || s.customTitle || s.aiTitle || s.firstPrompt || s.id.slice(0, 8);
}

export class SessionScanner {
  private cache = new Map<string, CacheEntry>();

  clearCache(): void {
    this.cache.clear();
  }

  async scan(projectsDir: string): Promise<ScanResult> {
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        this.cache.clear();
        return { sessions: [] };
      }
      return { sessions: [], error: `Cannot read ${projectsDir} (${code ?? 'unknown error'}).` };
    }

    const files: { file: string; folder: string }[] = [];
    let permissionErrors = 0;
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      const folderPath = path.join(projectsDir, dir.name);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      } catch {
        permissionErrors++;
        continue;
      }
      for (const e of entries) {
        // Sibling "<uuid>/" folders hold subagent/tool data and are ignored.
        if (!e.isFile() || !e.name.endsWith('.jsonl')) {
          continue;
        }
        const id = e.name.slice(0, -'.jsonl'.length);
        if (!isValidSessionId(id)) {
          continue;
        }
        files.push({ file: path.join(folderPath, e.name), folder: dir.name });
      }
    }

    const seen = new Set<string>();
    const sessions: SessionInfo[] = [];
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < files.length) {
        const item = files[index++];
        seen.add(item.file);
        const info = await this.scanFile(item.file, item.folder);
        if (info) {
          sessions.push(info);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, files.length) }, worker));

    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key)) {
        this.cache.delete(key);
      }
    }

    const result: ScanResult = { sessions };
    if (permissionErrors > 0 && sessions.length === 0) {
      result.error = `Could not read ${permissionErrors} project folder(s) in ${projectsDir}.`;
    }
    return result;
  }

  private async scanFile(file: string, folder: string): Promise<SessionInfo | null> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.info;
    }
    let info: SessionInfo | null = null;
    try {
      info = await parseTranscript(file, folder, stat);
    } catch {
      info = null;
    }
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    return info;
  }
}

interface Extracted {
  cwd?: string;
  gitBranch?: string;
  firstTimestamp?: number;
  firstPrompt?: string;
  sawUserMessage: boolean;
  aiTitle?: string;
  customTitle?: string;
}

async function readRange(fh: fs.promises.FileHandle, start: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fh.read(buf, offset, length - offset, start + offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buf.subarray(0, offset).toString('utf8');
}

async function parseTranscript(file: string, folder: string, stat: fs.Stats): Promise<SessionInfo | null> {
  const id = path.basename(file, '.jsonl');
  const size = stat.size;
  const whole = size <= CHUNK * 2;

  let headText: string;
  let tailText: string;
  const fh = await fs.promises.open(file, 'r');
  try {
    if (whole) {
      headText = await readRange(fh, 0, size);
      tailText = headText;
    } else {
      headText = await readRange(fh, 0, CHUNK);
      tailText = await readRange(fh, size - CHUNK, CHUNK);
    }
  } finally {
    await fh.close();
  }

  const headLines = headText.split('\n');
  let partialHeadLine: string | undefined;
  if (!whole) {
    partialHeadLine = headLines.pop();
  }
  const tailLines = tailText.split('\n');
  if (!whole) {
    tailLines.shift();
  }

  const ex: Extracted = { sawUserMessage: false };
  parseHead(headLines, ex);
  if (!ex.firstPrompt && partialHeadLine) {
    // A huge first prompt (pasted brief) can exceed the head window. Recover its start.
    const recovered = recoverPromptFromPartialLine(partialHeadLine);
    if (recovered) {
      ex.firstPrompt = recovered;
      ex.sawUserMessage = true;
    }
  }
  scanTitles(tailLines, ex);
  if (!ex.cwd) {
    // Very large first records (images, pasted files) can push every cwd past the head window.
    ex.cwd = cwdFromTail(tailLines, folder);
  }
  if (!whole && (!ex.aiTitle || !ex.customTitle)) {
    // Titles normally sit near the end, but fall back to anything in the head window.
    const fromHead: Extracted = { sawUserMessage: false };
    scanTitles(headLines, fromHead);
    ex.aiTitle = ex.aiTitle ?? fromHead.aiTitle;
    ex.customTitle = ex.customTitle ?? fromHead.customTitle;
  }

  const hasTitle = !!(ex.aiTitle || ex.customTitle);
  if (size < MIN_SIZE && !hasTitle) {
    return null;
  }
  // Fully read transcript with no user message and no title: an empty session.
  if (whole && !ex.sawUserMessage && !hasTitle) {
    return null;
  }

  const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  return {
    id,
    file,
    folder,
    cwd: ex.cwd ?? decodeFolderName(folder),
    cwdFromTranscript: !!ex.cwd,
    gitBranch: ex.gitBranch,
    firstPrompt: ex.firstPrompt,
    aiTitle: ex.aiTitle,
    customTitle: ex.customTitle,
    created: ex.firstTimestamp ?? birth,
    modified: stat.mtimeMs,
    size,
  };
}

function parseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') {
    return undefined;
  }
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseHead(lines: string[], ex: Extracted): void {
  for (const line of lines) {
    if (ex.cwd && ex.gitBranch && ex.firstTimestamp && ex.firstPrompt) {
      return;
    }
    const rec = parseJson(line);
    if (!rec) {
      continue;
    }
    if (!ex.cwd && typeof rec.cwd === 'string' && rec.cwd) {
      ex.cwd = rec.cwd;
    }
    if (!ex.gitBranch && typeof rec.gitBranch === 'string' && rec.gitBranch && rec.gitBranch !== 'HEAD') {
      ex.gitBranch = rec.gitBranch;
    }
    if (!ex.firstTimestamp && typeof rec.timestamp === 'string') {
      const t = Date.parse(rec.timestamp);
      if (Number.isFinite(t)) {
        ex.firstTimestamp = t;
      }
    }
    if (rec.type === 'user' && rec.isSidechain !== true) {
      ex.sawUserMessage = true;
      if (!ex.firstPrompt && rec.isMeta !== true) {
        const prompt = promptFromMessage(rec.message);
        if (prompt) {
          ex.firstPrompt = prompt;
        }
      }
    }
  }
}

function promptFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return normalizePrompt(content);
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          const p = normalizePrompt(text);
          if (p) {
            return p;
          }
        }
      }
    }
  }
  return undefined;
}

export function normalizePrompt(raw: string): string | undefined {
  let s = raw.trim();
  // Pasted content is wrapped in <pasted_content id="..."> tags; show the pasted text itself.
  const pasted = /^<pasted_content\b[^>]*>/.exec(s);
  if (pasted) {
    s = s.slice(pasted[0].length).replace(/<\/pasted_content>/g, ' ').trim();
  }
  if (!s || s.startsWith('<') || s.startsWith('[Request interrupted')) {
    return undefined;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) {
    return undefined;
  }
  return s.length > PROMPT_MAX ? s.slice(0, PROMPT_MAX - 1).trimEnd() + '…' : s;
}

/** Decode the start of a JSON string value from a truncated line. */
function recoverPromptFromPartialLine(line: string): string | undefined {
  if (!line.includes('"type":"user"') || line.includes('"isSidechain":true') || line.includes('"isMeta":true')) {
    return undefined;
  }
  let start = -1;
  for (const marker of ['"content":"', '"type":"text","text":"']) {
    const at = line.indexOf(marker);
    if (at >= 0) {
      start = at + marker.length;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  const src = line.slice(start, start + 4000);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      break;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = src[i + 1];
    if (next === undefined) {
      break;
    }
    i++;
    switch (next) {
      case 'n':
      case 'r':
      case 't':
        out += ' ';
        break;
      case 'u': {
        const hex = src.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          i = src.length;
          break;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next;
    }
  }
  return normalizePrompt(out);
}

/**
 * Later records may carry a subfolder the user cd'd into. Walk each cwd up to the
 * ancestor whose encoding matches the project folder name, which is the folder the
 * session was started in (and where `claude --resume` must run).
 */
function cwdFromTail(lines: string[], folder: string): string | undefined {
  for (const line of lines) {
    if (!line.includes('"cwd"')) {
      continue;
    }
    const rec = parseJson(line);
    if (!rec || typeof rec.cwd !== 'string' || !rec.cwd) {
      continue;
    }
    let dir = rec.cwd;
    for (;;) {
      if (encodedMatches(dir, folder)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

function findCustomTitle(rec: Record<string, unknown>, depth = 0): string | undefined {
  if (typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
    return rec.customTitle.trim();
  }
  if (depth >= 2) {
    return undefined;
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findCustomTitle(v as Record<string, unknown>, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Walk lines backwards; the latest ai-title and customTitle win. */
function scanTitles(lines: string[], ex: Extracted): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ex.aiTitle && ex.customTitle) {
      return;
    }
    const line = lines[i];
    const hasAi = !ex.aiTitle && line.includes('"aiTitle"');
    const hasCustom = !ex.customTitle && line.includes('"customTitle"');
    if (!hasAi && !hasCustom) {
      continue;
    }
    const rec = parseJson(line);
    if (!rec) {
      continue;
    }
    if (hasAi && rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) {
      ex.aiTitle = rec.aiTitle.trim().replace(/\s+/g, ' ');
    }
    if (hasCustom) {
      const t = findCustomTitle(rec);
      if (t) {
        ex.customTitle = t.replace(/\s+/g, ' ');
      }
    }
  }
}
