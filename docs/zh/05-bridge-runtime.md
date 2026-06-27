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

## 1.2 多 provider：claude / pi / codex

directCli 模式不限于 Claude Code。`directCliProvider` 选择 spawn 哪个本机 CLI，
三家共用同一套 spawn + 逐行 JSONL 管线，只是各自的 wire 协议不同——bridge 用一个
normalizer 把各家原生事件翻译成统一的 `system/assistant/result` 三元组：

| Provider | `directCliProvider` | 本机二进制 | 入口 | 协议 |
|---|---|---|---|---|
| Claude Code（默认） | `'claude'` | `claude` | `claude -p …` | stream-json |
| pi | `'pi'` | `pi` | `pi -p --mode json …` | JSONL（session/message_update/agent_end） |
| codex | `'codex'` | `codex` | `codex exec --json …` | JSONL（thread.started/item.*/turn.completed） |

```ts
// 复用本机的 pi CLI
const piSdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'pi',
  workDir: process.cwd(),
});

// 复用本机的 codex CLI
const codexSdk = await createActoviqBridgeSdk({
  directCli: true,
  directCliProvider: 'codex',
  workDir: process.cwd(),
});
```

**凭证注入按 provider 不同：** claude 走 `ANTHROPIC_*`（见上节）；pi/codex 读各家
自己的环境变量（`OPENAI_API_KEY` 等）。在 `~/.actoviq/settings.json` 的 `env` 块里
直接写对应 provider 的 key 即可——pi/codex 不会做 `ANTHROPIC_*` 重映射。

**Introspection 降级：** pi 和 codex 的启动事件不携带 tools/skills/agents/slash_commands
清单（claude 会带）。因此 `getRuntimeInfo()` / `listSkills()` / `getRuntimeCatalog()` 等
内省方法对 pi/codex 返回有限数据（tools/skills 为空数组）。run / stream / session /
createSession / continueMostRecent / fork 等生命周期方法三家完整对齐。

实现细节见 `src/parity/bridgeProviders.ts`（每个 provider 一个 `RuntimeProvider`：
argv 构建、env 注入、事件归一化）。

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
