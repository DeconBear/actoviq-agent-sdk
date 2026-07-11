import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type GitStatusEntry = { x: string; y: string; file: string };

export type SplitGitStatus = {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
};

/** Split porcelain status into VS Code-style Staged / Changes lists. */
export function splitGitStatus(status: GitStatusEntry[]): SplitGitStatus {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  for (const entry of status) {
    const x = entry.x || '';
    const y = entry.y || '';
    if (x && x !== '?') staged.push(entry);
    if ((y && y !== '?') || x === '?') unstaged.push(entry);
  }
  return { staged, unstaged };
}

export type PathTreeNode = {
  name: string;
  /** Relative path from workspace/repo root (posix-ish with /). */
  relPath: string;
  kind: 'dir' | 'file';
  children?: PathTreeNode[];
  badge?: string;
  entry?: GitStatusEntry;
};

export type PathTreeLeaf = {
  file: string;
  badge?: string;
  entry?: GitStatusEntry;
};

/** Build a directory tree from flat relative file paths (VS Code SCM tree). */
export function buildPathTree(leaves: PathTreeLeaf[]): PathTreeNode[] {
  const root: any = { name: '', relPath: '', kind: 'dir', children: [], childMap: new Map() };

  for (const leaf of leaves) {
    const parts = leaf.file.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    let rel = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      rel = rel ? rel + '/' + part : part;
      const isFile = i === parts.length - 1;
      if (!node.childMap) node.childMap = new Map();
      let next = node.childMap.get(part);
      if (!next) {
        next = {
          name: part,
          relPath: rel,
          kind: isFile ? 'file' : 'dir',
          children: isFile ? undefined : [],
          childMap: isFile ? undefined : new Map(),
        };
        node.childMap.set(part, next);
        if (!node.children) node.children = [];
        node.children.push(next);
      } else if (isFile) {
        next.kind = 'file';
      }
      if (isFile) {
        next.badge = leaf.badge;
        next.entry = leaf.entry;
      }
      node = next;
    }
  }

  function sortNode(node: any): PathTreeNode {
    if (node.children && node.childMap) {
      node.children.sort((a: PathTreeNode, b: PathTreeNode) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      node.children = node.children.map((child: any) => sortNode(child));
    }
    const clean: PathTreeNode = {
      name: node.name,
      relPath: node.relPath,
      kind: node.kind,
    };
    if (node.children) clean.children = node.children;
    if (node.badge) clean.badge = node.badge;
    if (node.entry) clean.entry = node.entry;
    return clean;
  }

  return (root.children || []).map((child: any) => sortNode(child));
}

export function gitStatusBadge(entry: GitStatusEntry, side: 'staged' | 'unstaged'): string {
  if (side === 'staged') return entry.x || 'M';
  if (entry.x === '?' || entry.y === '?') return 'U';
  return entry.y || entry.x || 'M';
}

export type GitCommitRef = {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
};

export type GitCommitInfo = {
  hash: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Relative date primary display (e.g. "2 hours ago"). */
  relativeDate: string;
  /** ISO absolute author date. */
  absoluteDate: string;
  /** Back-compat alias for relativeDate (older Git surface). */
  date: string;
  parents: string[];
  decorations: string[];
  refs: GitCommitRef[];
};

/** Parse `git log --decorate=short --pretty=format:%h%x1f...%D%x1e` records. */
export function parseGitCommitLog(raw: string): GitCommitInfo[] {
  if (!raw.trim()) return [];
  return raw
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/, '').trimEnd())
    .filter(Boolean)
    .map((record) => {
      const [
        hash = '',
        subject = '',
        author = '',
        authorEmail = '',
        relativeDate = '',
        absoluteDate = '',
        parentsRaw = '',
        decorationsRaw = '',
      ] = record.split('\x1f');
      const decorations = decorationsRaw
        .split(',')
        .map((decoration) => decoration.trim())
        .filter(Boolean);
      const refs: GitCommitRef[] = [];
      const pushRef = (name: string, kind: GitCommitRef['kind']) => {
        if (!name) return;
        if (refs.some((ref) => ref.name === name && ref.kind === kind)) return;
        refs.push({ name, kind });
      };
      for (const decoration of decorations) {
        if (decoration === 'HEAD') {
          pushRef('HEAD', 'head');
          continue;
        }
        if (decoration.startsWith('HEAD -> ')) {
          pushRef('HEAD', 'head');
          pushRef(decoration.slice('HEAD -> '.length), 'local');
          continue;
        }
        if (decoration.startsWith('tag: ')) {
          pushRef(decoration.slice('tag: '.length), 'tag');
          continue;
        }
        if (decoration.includes('/')) pushRef(decoration, 'remote');
        else pushRef(decoration, 'local');
      }
      return {
        hash,
        subject,
        author,
        authorEmail,
        relativeDate,
        absoluteDate,
        date: relativeDate,
        parents: parentsRaw.split(/\s+/).filter(Boolean),
        decorations,
        refs,
      };
    });
}

function normalizeFsPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolved = normalizeFsPath(candidate);
  const resolvedRoot = normalizeFsPath(root);
  if (resolved === resolvedRoot) return true;
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolved.startsWith(prefix);
}

/** Resolve a request path against the workspace root (absolute or relative). */
function resolveWorkspacePath(requestPath: string, workDir: string): string {
  const trimmed = requestPath.trim();
  const root = path.resolve(workDir);
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
}

export type WorkspaceFileReadResult = {
  path: string;
  size: number;
  text?: string;
  binary?: boolean;
  truncated?: boolean;
};

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.html', '.htm',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh', '.ps1',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sql', '.graphql', '.vue', '.svelte', '.xml', '.svg', '.gitignore', '.dockerignore',
  '.editorconfig', '.npmrc', '.nvmrc', '.d.ts',
]);

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) > 0.3;
}

function isForcedTextPath(resolved: string): boolean {
  const ext = path.extname(resolved).toLowerCase();
  const base = path.basename(resolved);
  // Treat multi-suffix TypeScript declarations as text even when extname is ".ts".
  if (base.toLowerCase().endsWith('.d.ts')) return true;
  return TEXT_EXT.has(ext) || TEXT_EXT.has(base) || !ext;
}

/** Read a workspace file for the Project Files preview panel. */
export async function readWorkspaceFile(
  requestPath: string,
  workDir: string,
  maxBytes = 512 * 1024,
): Promise<WorkspaceFileReadResult> {
  const trimmed = requestPath?.trim() || '';
  if (!trimmed) throw new Error('Missing file path');
  const root = path.resolve(workDir);
  const resolved = resolveWorkspacePath(trimmed, root);
  if (!isPathInsideRoot(resolved, root)) {
    throw new Error('Path escapes workspace');
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Not a file: ' + resolved);
  const size = info.size;
  const forceText = isForcedTextPath(resolved);
  const buf = await readFile(resolved);
  if (!forceText && looksBinary(buf)) {
    return { path: resolved, size, binary: true };
  }
  const slice = buf.subarray(0, Math.min(buf.length, maxBytes));
  const text = slice.toString('utf8');
  return {
    path: resolved,
    size,
    text,
    truncated: buf.length > maxBytes,
  };
}

export type WorkspaceFileWriteResult = {
  path: string;
  size: number;
};

/** Write a text workspace file after applying the same preview confinement checks. */
export async function writeWorkspaceFile(
  requestPath: string,
  text: string,
  workDir: string,
  maxBytes = 512 * 1024,
): Promise<WorkspaceFileWriteResult> {
  const trimmed = requestPath?.trim() || '';
  if (!trimmed) throw new Error('Missing file path');
  if (typeof text !== 'string') throw new Error('File content must be text');

  const root = path.resolve(workDir);
  const resolved = resolveWorkspacePath(trimmed, root);
  if (!isPathInsideRoot(resolved, root)) {
    throw new Error('Path escapes workspace');
  }

  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Not a file: ' + resolved);
  const existing = await readFile(resolved);
  if (!isForcedTextPath(resolved) && looksBinary(existing)) {
    throw new Error('Cannot write binary file');
  }

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) {
    throw new Error(`File content exceeds ${maxBytes} byte limit`);
  }
  await writeFile(resolved, text, 'utf8');
  return { path: resolved, size: byteLength };
}

export type GitDiffResult = {
  path: string;
  staged: boolean;
  patch: string;
  truncated?: boolean;
};

function gitTextAt(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }).trimEnd();
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    if (typeof err.stdout === 'string' && err.stdout) return String(err.stdout).trimEnd();
    throw new Error(err.stderr?.trim() || err.message || 'git failed');
  }
}

/** Read-only git diff for a single path (staged or worktree). */
export function readGitDiff(
  workDir: string,
  filePath: string,
  staged: boolean,
  maxChars = 200_000,
): GitDiffResult {
  const root = path.resolve(workDir);
  if (gitTextAt(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error('Not a git repository');
  }
  const rel = filePath.replace(/\\/g, '/');
  // Reject absolute paths that escape the repo; allow relative paths as git sees them.
  if (path.isAbsolute(filePath)) {
    if (!isPathInsideRoot(filePath, root)) throw new Error('Path escapes repository');
  }
  const args = staged
    ? ['diff', '--cached', '--', rel]
    : ['diff', '--', rel];
  let patch = gitTextAt(root, args);
  // Untracked / new files often yield an empty `git diff`; synthesize an added patch.
  if (!patch && !staged) {
    const status = gitTextAt(root, ['status', '--porcelain=v1', '--', rel]);
    if (status.startsWith('??') || /^\s*A\s/.test(status) || status.includes('A\t') || status.startsWith('A ')) {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
      if (!isPathInsideRoot(abs, root)) throw new Error('Path escapes repository');
      try {
        const body = readFileSync(abs, 'utf8');
        const lines = body.split(/\r?\n/);
        patch = [
          `diff --git a/${rel} b/${rel}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${rel}`,
          `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
          ...lines.map((line) => `+${line}`),
        ].join('\n');
      } catch {
        patch = '';
      }
    }
  }
  const truncated = patch.length > maxChars;
  return {
    path: rel,
    staged,
    patch: truncated ? patch.slice(0, maxChars) + '\n\n… truncated …' : patch,
    truncated: truncated || undefined,
  };
}
