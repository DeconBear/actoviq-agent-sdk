# 17 — CLI 与 TUI

## 架构

`hadamard-tui` 是唯一的交互式终端 Agent。它统一提供原生 scrollback、
自定义键盘处理、流式工具状态，以及与 GUI 共用的可搜索斜杠命令面。

主要文件：

| 文件 | 职责 |
|---|---|
| `cli/hadamard-tui.ts` | TUI 入口 |
| `tui/hadamardTui.ts` | 完整 TUI 实现 |
| `tui/transcript.ts` | 对话与工具状态渲染 |
| `ui/commandSurface.ts` | TUI/GUI 共用命令及二级命令目录 |

### 终端 UI

位置：`src/tui/hadamardTui.ts`

使用备用屏幕缓冲区，界面布局：

```
┌─────────────────────────────────────────────┐
│  对话区域（原生 scrollback）                  │
│  • 助手文本流式写入缓冲区                     │
│  • 工具调用及实时状态                         │
├─────────────────────────────────────────────┤
│  状态行：⏳ Hadamard Agent · 12s · 5 tools   │
├─────────────────────────────────────────────┤
│  提示栏：> 用户输入                     [Ctrl] │
├─────────────────────────────────────────────┤
│  斜杠命令菜单（按 / 触发）                    │
│  /help  /model  /resume  /sessions  ...      │
└─────────────────────────────────────────────┘
```

### 配置加载行为

```typescript
// 显式传递的配置路径（argv[3]）：
try { await loadJsonConfigFile(CONFIG_PATH); } catch (e) {
  // 大声失败 — 不静默回退到默认值
  process.stderr.write(`✕ 加载配置失败...`);
  process.exit(2);
}

// 默认 settings.json：
try { await loadDefaultHadamardSettings(); } catch (e) {
  // 容忍缺失（首次运行），警告其他错误
  if (!/not found|ENOENT/i.test(e.message)) {
    process.stderr.write(`⚠ 默认设置加载失败: ${e.message}`);
  }
}
```

---

## v0.5.0: 新增斜杠命令

REPL 和 TUI 均新增三个斜杠命令：

### /workflows

```
/workflows list           — 列出已保存的动态工作流脚本
/workflows run <name>     — 执行工作流（含实时进度日志）
```

底层：`listWorkflows()` / `loadWorkflow()` + `WorkflowScriptRuntime`

### /worktree

```
/worktree enter <name>    — 创建并进入 git worktree
/worktree exit            — 退出当前 worktree 返回原始目录
/worktree list            — 列出所有 worktree（含脏/净状态）
```

底层：`WorktreeService.createAndEnterWorktree()` / `exitWorktree()` / `listWorktrees()`

### /team

```
/team list                — 列出已保存的 Model Team 定义
/team ask <name> <prompt> — 向指定团队提问（含模式、耗时、费用报告）
```

底层：`listTeamDefinitions()` / `loadTeamDefinition()` + `createModelTeam().ask()`
### 默认系统提示词（REPL）

包含：环境信息（工作目录、git 状态、平台、日期）+ 语气和风格 + 工作规则 + Git 安全协议。
