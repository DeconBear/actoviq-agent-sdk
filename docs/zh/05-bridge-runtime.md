# 05. Bridge Runtime 兼容说明

这一章解释什么是 bridge，以及什么时候才需要使用它。

## 1. 前置条件 — 链接运行时 bundle

actoviq-bridge-sdk 依赖第三方 agent runtime 的运行时 bundle（例如 Claude Code）。该文件**不包含**在 actoviq-agent-sdk 包中。

如果你已安装 Claude Code，可以链接它的 bundle：

```bash
# Claude Code 的 npm 包名为 @anthropic-ai/claude-code

# macOS / Linux（npm 全局安装）
npx actoviq-link-runtime /usr/local/lib/node_modules/@anthropic-ai/claude-code

# macOS / Linux（nvm 安装）
npx actoviq-link-runtime ~/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code

# Windows
npx actoviq-link-runtime %AppData%\npm\node_modules\@anthropic-ai\claude-code

# 或者让 npm 自己找：
npx actoviq-link-runtime "$(npm root -g)/@anthropic-ai/claude-code"
```

或者设置环境变量：

```bash
export ACTOVIQ_RUNTIME_BUNDLE="/path/to/runtime-bundle"
```

没有这个 bundle，actoviq-bridge-sdk 功能将不可用。

> **注意（原生 exe 形态的 Claude Code）：** 新版 `@anthropic-ai/claude-code`
> 以原生可执行文件发布（`bin/claude.exe`），包内**没有** `runtime.bundle.br`，
> `actoviq-link-runtime` 对它无法生效。此时请改用下面的 **directCli 模式**，
> 它直接 spawn 本机 `claude` 二进制，不需要 bundle。

## 1.1 直接复用本机 Claude Code（directCli 模式）

如果你已在 PATH 上装好 Claude Code，可以跳过 bundle，直接让 bridge
spawn 本机的 `claude`：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';

const sdk = await createActoviqBridgeSdk({
  directCli: true,           // spawn 本机 claude，绕过 runtime.bundle.br + Bun
  // executable: 'claude',   // 可选，默认在 PATH 上找 `claude`
  workDir: process.cwd(),
});

const result = await sdk.run('用一句话总结当前目录。');
```

directCli 模式的工作方式（与 multica daemon 的 "shell out by name" 一致）：
bridge 在 PATH 上找到 `claude`，以 `-p --output-format stream-json --verbose …`
参数 spawn 它，并解析标准 `system/assistant/result` 事件流——与 bundle 模式
的协议完全相同，只是子进程换成了你本机安装的官方 claude。

**Provider 隔离（关键能力）：** directCli 模式**完整保留** actoviq 的 env
注入链（`~/.actoviq/settings.json` 的 `env` 块 → `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 等，见 `anthropicEnvMapping.ts`）。
因此你可以让 **交互式 `claude` 走 Claude 官方，而 bridge 下的 `claude` 子进程
重定向到 DeepSeek 等其他 provider**——子进程的 `ANTHROPIC_*` 环境变量覆盖
`~/.claude/settings.json`，两者互不干扰。例：

```json
// ~/.actoviq/settings.json（仅影响 bridge 子进程，不影响交互式 claude）
{
  "env": {
    "ACTOVIQ_AUTH_TOKEN": "sk-...",
    "ACTOVIQ_BASE_URL": "https://api.deepseek.com/anthropic",
    "ACTOVIQ_DEFAULT_MAX_MODEL": "deepseek-v4-pro"
  }
}
```

> 提示：若你的 PowerShell 当前 shell 已 `ANTHROPIC_API_KEY` 指向 Claude 官方，
> 且 settings.json 未配凭证，子进程会回退到该值——请把 provider 配置写全。

## 1.2 六大 provider（claude / pi / codex / codewhale / reasonix / crush）

| Provider | `directCliProvider` | 本机二进制 | 入口 | 协议 |
|---|---|---|---|---|
| Claude Code（默认） | `'claude'` | `claude` | `claude -p --output-format stream-json …` | stream-json |
| pi | `'pi'` | `pi` | `pi -p --mode json …` | JSONL |
| codex | `'codex'` | `codex` | `codex exec --json …` | JSONL |
| CodeWhale | `'codewhale'` | `codewhale` | `codewhale exec --auto --output-format stream-json …` | stream-json（与 claude 相同） |
| Reasonix | `'reasonix'` | `reasonix` | `reasonix run [--model] [--effort] <task>` | 纯文本 |
| Crush | `'crush'` | `crush` | `crush run [--model] [--session] <prompt>` | 纯文本 |

```ts
const sdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'codewhale',   // 或 'reasonix', 'crush', …
  workDir: process.cwd(),
});
```

**凭证：** claude → `ANTHROPIC_*`；codewhale → ANTHROPIC_*/DEEPSEEK_*；
reasonix → DEEPSEEK_*；crush → OPENAI_*/ANTHROPIC_*。
在 `~/.actoviq/settings.json` 的 `env` 块里直接写对应 provider 的 key。

**Introspection 降级** 适用于 pi/codex/reasonix/crush（启动事件不含 tools/skills 清单）。
run/stream/session 等生命周期方法六家完整对齐。

## 1.3 环境覆盖与自动检测

### `ACTOVIQ_<PROVIDER>_PATH`

当 CLI 不在 `PATH` 上时，用它覆盖自动检测的二进制路径：

```bash
export ACTOVIQ_CLAUDE_PATH=/opt/claude-code/bin/claude
export ACTOVIQ_CODEX_PATH=/custom/codex
export ACTOVIQ_REASONIX_PATH=~/bin/reasonix
# … 每个 provider 都遵循 ACTOVIQ_<ID>_PATH 模式
```

写在 `~/.actoviq/settings.json` 的 `env` 块（或顶层）——与 `ACTOVIQ_BASH_PATH` 惯例一致。

### `bridge` 设置块

```jsonc
// ~/.actoviq/settings.json
{
  "bridge": {
    "defaultProvider": "codewhale",
    "providers": {
      "crush": { "path": "/opt/crush" }
    }
  }
}
```

解析优先级（全部在内存中，run 时无文件 I/O）：
`executable` 选项 → `ACTOVIQ_<ID>_PATH` 环境变量 → `bridge.providers[id].path` → `PATH`。

### `detectBridgeProviders()` API

```ts
import { detectBridgeProviders } from 'actoviq-agent-sdk';

const providers = await detectBridgeProviders();
// [{ id:'claude', available:true, path:'/…/claude.cmd', version:'2.1.186', displayName:'…' }, …]
```

返回每个已注册 provider 的条目，包含 best-effort `--version` 探测。
被 CLI 的 `/bridge` 向导、TUI 的 `/bridge` 控制面板、GUI 的 Settings→Bridge 面板使用。

### TUI 运行时切换

在 TUI 中，`/bridge` 打开控制面板。激活某个 provider（选中其所在行，或
`/bridge switch <id>`）会将其设为当前运行时：此后你直接输入的每条普通 prompt
都会经该 bridge 运行时执行，并复用整个 TUI——实时状态 spinner、流式 transcript、
工具卡片、Esc 中断、输入历史。`/bridge off` 切回进程内 Hadamard SDK。
`/bridge run <prompt>` 不改变开关、强制执行单次 bridge 轮次。每个 provider 都维护一个
持久的多轮会话：首轮播种（`--session-id`），后续轮次恢复（`--resume`/`--continue`），
因此运行时会记住之前的轮次——"相当于一直用 claude code，直到你退出"。切换 provider 会
保留各运行时的会话（切回即恢复），且 bridge 轮次也会追加到 Hadamard 会话存储中，使可见
对话在切换 bridge↔hadamard 及后续 `/resume` 时都不丢失。

### 命名 bridge 配置

`/bridge config` 打开配置管理界面：**新增配置**（或对已有配置 **编辑**/**删除**）会进入一个
单页**配置编辑器**，一次性显示所有字段——**名称**、**provider**（运行时）、**apiKey**、
**baseURL**、可选的 **model**——并显示每个字段的当前值。你可以按任意顺序编辑任意字段（例如先
配置好 key，再回去修改名称），然后**保存**提交或**取消**放弃。配置保存在
`~/.actoviq/bridge-configs.json`。每个 config 是一个完整预设——例如
`deepseek-claude`（provider=`claude`、`ANTHROPIC_BASE_URL=https://api.deepseek.com`、
`ANTHROPIC_API_KEY=…`、`model=deepseek-chat`）——可以保留多个后端配置，按名称切换。

保存后，`/bridge` 会列出**已保存的配置**；选中一个（或 `/bridge switch <名称>`）即激活该
运行时。config 的凭证会**逐轮注入**（作为 per-run env 覆盖，优先级高于
`~/.actoviq/settings.json`），随后作为普通多轮对话运行，支持全部 agent 功能。`/bridge off`
切回进程内 SDK。可在 `/bridge config` 中编辑/删除配置；编辑当前激活的配置将在下一轮生效。

按 provider 的凭证映射：`claude`/`codewhale` → `ANTHROPIC_*`；`pi`/`codex` → `OPENAI_*`
（baseURL 含 anthropic 时 pi 用 `ANTHROPIC_*`）；`reasonix` → `DEEPSEEK_API_KEY`；
`crush` → `OPENAI_API_KEY`。实现：`src/parity/bridgeConfigs.ts`（`buildConfigEnv`）。

## 1.4 问题排查——没有检测到 runtime？

1. **安装 CLI**（`npm i -g @anthropic-ai/claude-code`、`npm i -g codewhale`、…）
   并重启 shell 确保它在 `PATH` 上。
2. **运行 `npx actoviq-interactive-agent`** 并输入 `/bridge`——向导会展示检测到的
   provider，让你选择一个作为默认。
3. **设置 `ACTOVIQ_<ID>_PATH`**（见 1.3），适用于二进制已安装但不在 `PATH` 的情况
   （CI、不继承 shell profile 的 IDE 启动器等常见场景）。
4. **让 Claude Code 帮忙：** 把 `/providers` 的输出（或 GUI 的「Detect runtimes」
   按钮结果）贴给 Claude Code，让它指导安装和配置。

实现：`src/parity/bridgeProviders.ts`（各 provider 的 argv/env/normalizer +
`BRIDGE_PROVIDER_CREDENTIALS` 凭证就绪提示），`src/cli/bridge-interactive-agent.ts`
（/bridge 向导），`src/tui/actoviqTui.ts`（TUI `/bridge` 控制面板——一键激活 provider、
逐 provider 设置模型、凭证提示、实跑状态；`run`/`switch`/`model`/`setup`/`off`/`help`
子命令支持自动补全），`src/gui/actoviqGui.ts`（bridge 面板 + 实跑）。

## 2. bridge 是什么

bridge 可以理解成一层兼容适配层。它暴露的是更偏 runtime 风格的执行路径。

入口：

```ts
import { createActoviqBridgeSdk } from 'actoviq-agent-sdk';
```

## 2. 什么情况下才需要 bridge

更适合使用 bridge 的场景：

1. 你要研究现有 runtime 的行为
2. 你要查看 runtime 当前有哪些 tools / skills / agents
3. 你要分析 runtime 事件流
4. 你要做兼容层、迁移层或对照测试

如果你是在开发一个新的业务项目，通常优先使用 Hadamard SDK：

```ts
createAgentSdk()
```

bridge 更适合“兼容”和“研究”，不是默认主路径。

## 3. 最小 bridge 示例

```ts
import {
  createActoviqBridgeSdk,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

const result = await sdk.run('检查 examples 目录，并总结 quickstart.ts。');

console.log(result.text);
console.log(result.events.length);
```

## 4. Runtime Introspection

bridge 可以查看当前 runtime 暴露出来的能力：

```ts
const runtime = await sdk.getRuntimeInfo();

console.log(runtime.tools);
console.log(runtime.skills);
console.log(runtime.agents);
```

仓库示例：

- [examples/bridge-introspection.ts](../../examples/bridge-introspection.ts)
- [examples/bridge-sdk.ts](../../examples/bridge-sdk.ts)

## 5. Bridge Helper

bridge 侧还支持：

1. `sdk.runSkill(...)`
2. `sdk.runWithAgent(...)`
3. `sdk.sessions.continueMostRecent(...)`
4. `sdk.sessions.fork(...)`
5. `session.runSkill(...)`
6. `session.compact(...)`

## 6. Bridge 事件 Helper

如果你要分析 runtime 输出的事件流，可以使用：

1. `getActoviqBridgeTextDelta(...)`
2. `extractActoviqBridgeToolRequests(...)`
3. `extractActoviqBridgeToolResults(...)`
4. `extractActoviqBridgeTaskInvocations(...)`
5. `analyzeActoviqBridgeEvents(...)`

下一章：

- [05-testing-troubleshooting-cheatsheet.md](./05-testing-troubleshooting-cheatsheet.md)
