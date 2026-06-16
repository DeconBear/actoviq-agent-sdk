# 15 — Workspace & Worktrees

## Architecture

The workspace module manages isolated working directories for agents — temp
directories, directory copies, and git worktrees. Worktrees are the primary
isolation mechanism for parallel subagents.

Location: `src/workspace/actoviqWorkspace.ts`

### Worktree Types

| Kind | Creation | Cleanup | Use Case |
|---|---|---|---|
| `directory` | `mkdir` | Manual | Fixed workspace |
| `temp` | `mkdtemp` | Auto-delete on dispose | One-shot isolated work |
| `git-worktree` | `git worktree add` | Auto-delete if clean | Parallel agent isolation |

## Module Design

### `ActoviqWorkspace` — The Abstractions

```typescript
class ActoviqWorkspace {
  readonly id: string;
  readonly kind: 'directory' | 'temp' | 'git-worktree';
  readonly path: string;
  readonly metadata: Record<string, string>;

  async dispose(): Promise<void> {
    // Run disposer callback (e.g., rm -rf, git worktree remove)
    // Idempotent: no-op if already disposed
  }
}
```

### Factory Functions

```typescript
// Fixed directory
createWorkspace({ path, copyFrom?, ensureExists? }) → ActoviqWorkspace

// Temporary directory (auto-cleaned via disposer)
createTempWorkspace({ parentDir?, prefix?, copyFrom? }) → ActoviqWorkspace

// Git worktree (auto-cleaned if no changes)
createGitWorktreeWorkspace({
  repositoryPath,     // Path to git repo
  path?,              // Target path (auto-generated if omitted)
  name?,              // Worktree name
  branch?,            // Branch name (auto-generated)
  ref?,               // Git ref (default HEAD)
  detach?,            // Detached HEAD
  force?,             // Force remove existing
}) → ActoviqWorkspace
```

### Git Worktree Creation

```typescript
async function createGitWorktreeWorkspace(options): Promise<ActoviqWorkspace> {
  // 1. Resolve repository root (git rev-parse --show-toplevel)
  // 2. Generate target path (if not provided)
  // 3. Build git worktree add command
  // 4. Execute: git -C <repo> worktree add [--force] [--detach] [-b <branch>] <path> [<ref>]
  // 5. Return ActoviqWorkspace with disposer:
  //    - Try: git worktree remove --force <path>
  //    - Fallback: rm -rf <path> (with safety checks)
}
```

### Safety Checks

Before recursive deletion, the module verifies the target is NOT:
- Filesystem root
- User home directory
- Current working directory
- The repository root (protected path)

```typescript
function assertSafeRecursiveRemovalTarget(target: string, protectedPaths: string[]): void {
  const unsafe = [path.parse(target).root, os.homedir(), process.cwd(), ...protectedPaths];
  if (unsafe.some(u => isSamePath(target, u))) {
    throw new ActoviqSdkError(`Refusing to recursively remove unsafe path: ${target}`);
  }
}
```

### Worktree Disposal

Clean worktrees (no uncommitted changes, no new commits, no untracked files)
are auto-deleted. Dirty worktrees are retained — the caller receives the path
and branch for manual review or merge.

```typescript
// In agentClient.ts:
private async finalizeDelegatedWorkspace(workspace?: ActoviqWorkspace): Promise<boolean> {
  if (!workspace) return false;
  if (workspace.kind !== 'git-worktree') { await workspace.dispose(); return false; }

  const dirty = await isGitWorkspaceDirty(workspace.path);
  if (dirty) return true; // Retain — caller handles

  await workspace.dispose();
  return false; // Clean — disposed
}
```

### `isGitWorkspaceDirty()`

```typescript
async function isGitWorkspaceDirty(workDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd: workDir, timeout: 10_000, windowsHide: true,
    });
    return stdout.trim().length > 0;
  } catch {
    return false; // Git unavailable → treat as clean (prevent worktree leaks)
  }
}
```

## Code Details

### Subagent Worktree Integration

When a subagent uses `isolation: 'worktree'`:

1. `prepareDelegatedWorkspace()` calls `createGitWorktreeWorkspace()`
2. Child session's `workDir` is set to the worktree path
3. Agent executes in complete isolation
4. On completion, `finalizeDelegatedWorkspace()` checks for changes
5. Clean → auto-delete; dirty → retain, return path in result

### Worktree Path Generation

```typescript
// Default: under repo/.actoviq/worktrees/<name>/
const targetPath = options.path
  ?? path.resolve(repositoryRoot, '.actoviq', 'worktrees', options.name ?? randomId());

// Branch: actoviq-agent-<random8>
const branch = options.branch ?? `actoviq-agent-${randomUUID().slice(0, 8)}`;
```

### Non-Git VCS Support (Planned)

Future: `WorktreeCreate`/`WorktreeRemove` hooks will allow custom VCS backends
(SVN, Perforce, Mercurial) by replacing the default `git worktree` logic.
