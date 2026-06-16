# 17 — CLI 与 TUI

## 架构

两个交互终端：轻量级 scrollback REPL（`actoviq-react`）和完整终端 UI（`actoviq-tui`）。两者使用相同的 SDK 运行时，但渲染方式不同。

| | actoviq-react | actoviq-tui |
|---|---|---|
| **渲染** | 原生 scrollback（readline） | 备用屏幕缓冲区（完整 TUI） |
| **输入** | readline + 历史记录 | 自定义键盘处理 |
| **流式** | 内联文本 + 工具指示器 | 可重绘面板 |
| **斜杠命令** | 内联解析 | 可搜索菜单 |
| **复杂度** | ~370 行 | ~1000+ 行 |

### `actoviq-react` — Scrollback REPL

位置：`src/cli/actoviq-react.ts`

```
main()
    ├── 加载配置（显式路径或默认 settings.json）
    ├── createAgentSdk({ workDir, tools, permissionMode })
    ├── createSession({ title, permissionMode })
    │
    ├── readline 接口（completer: 斜杠命令）
    │
    ├── 斜杠命令：/help, /clear, /exit, /model, /permissions,
    │               /sessions, /resume, /tools, /memory, /compact, /dream
    │
    └── 消息处理（processMsg）
        ├── session.stream(text, { systemPrompt, signal, ... })
        └── 事件处理：
            ├── request.started → 显示迭代编号
            ├── response.text.delta → 写入 stdout
            ├── tool.call → "⚡ ToolName(args)" 黄色
            ├── tool.result → "✓/✗ 耗时 输出"
            └── error → 错误消息
```

### `actoviq-tui` — 完整终端 UI

位置：`src/tui/actoviqTui.ts`

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
try { await loadDefaultActoviqSettings(); } catch (e) {
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
