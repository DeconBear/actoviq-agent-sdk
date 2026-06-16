# 15 — 工作区与 Worktree

## 架构

工作区模块管理 agent 的隔离工作目录——临时目录、目录复制和 git worktree。Worktree 是并行子代理的主要隔离机制。

位置：`src/workspace/actoviqWorkspace.ts`

### Worktree 类型

| 类型 | 创建方式 | 清理方式 | 用例 |
|---|---|---|---|
| `directory` | `mkdir` | 手动 | 固定工作区 |
| `temp` | `mkdtemp` | dispose 时自动删除 | 一次性隔离工作 |
| `git-worktree` | `git worktree add` | 无更改时自动删除 | 并行 agent 隔离 |

### `ActoviqWorkspace` — 抽象

```typescript
class ActoviqWorkspace {
  readonly id: string;
  readonly kind: 'directory' | 'temp' | 'git-worktree';
  readonly path: string;
  readonly metadata: Record<string, string>;

  async dispose(): Promise<void> {
    // 运行 disposer 回调（如 rm -rf, git worktree remove）
    // 幂等：已 dispose 则无操作
  }
}
```

### 工厂函数

```typescript
createWorkspace({ path, copyFrom?, ensureExists? }) → ActoviqWorkspace
createTempWorkspace({ parentDir?, prefix?, copyFrom? }) → ActoviqWorkspace
createGitWorktreeWorkspace({
  repositoryPath,     // Git 仓库路径
  path?, name?,       // 目标路径和名称
  branch?, ref?,      // 分支和引用
  detach?, force?,    // 分离 HEAD、强制覆盖
}) → ActoviqWorkspace
```

### Git Worktree 创建

```typescript
async function createGitWorktreeWorkspace(options): Promise<ActoviqWorkspace> {
  // 1. 解析仓库根目录（git rev-parse --show-toplevel）
  // 2. 生成目标路径
  // 3. 构建 git worktree add 命令
  // 4. 执行：git worktree add [--force] [-b <branch>] <path> [<ref>]
  // 5. 返回带 disposer 的 ActoviqWorkspace：
  //    - 尝试：git worktree remove --force <path>
  //    - 回退：rm -rf <path>（含安全检查）
}
```

### 安全检查

递归删除前验证目标路径不是：
- 文件系统根目录
- 用户主目录
- 当前工作目录
- 仓库根目录

### `isGitWorkspaceDirty()`

```typescript
async function isGitWorkspaceDirty(workDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd: workDir, timeout: 10_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false; // Git 不可用 → 视为干净（防止 worktree 泄漏）
  }
}

---

## v0.5.0: EnterWorktree / ExitWorktree 工具

位置：`src/tools/enterWorktree.ts`, `src/tools/exitWorktree.ts`, `src/worktree/worktreeService.ts`

### EnterWorktree

参数：`name`, `branch`, `ref`, `detach`, `pr`, `path`

- 创建隔离 git worktree，切换 agent 工作目录
- 默认位置：`.actoviq/worktrees/<name>/`
- PR checkout：自动 fetch `pull/<n>/head`
- 从 worktree 内部只能通过 `path` 切换到另一个已有 worktree

### ExitWorktree

栈式恢复到原始工作目录。脏 worktree 保留分支和目录。

### WorktreeService

- 自动命名：`generateWorktreeName()` → `bright-crimson-fox`
- `baseRef: "fresh"` (origin/HEAD) 或 `"head"` (本地)
- `.worktreeinclude`：gitignore 语法，自动复制被忽略文件
- 脏检测：`git status --porcelain`

### Worktree Hooks

位置：`src/worktree/worktreeHooks.ts`

- `WorktreeCreate` hook：stdin JSON `{name}` → stdout 目录路径
- `WorktreeRemove` hook：stdin JSON `{name, path}`
- hooks 存在时 `.worktreeinclude` 跳过

### conversationEngine.ts

`sessionWorkDir` 选项：worktree 切换时动态替代 `config.workDir`

### TUI/REPL

```
/worktree enter <name> | exit | list
```
```
