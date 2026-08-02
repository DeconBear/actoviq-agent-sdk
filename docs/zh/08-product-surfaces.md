# SDK、CLI/TUI 与 GUI 的三层能力边界

最近核验：2026-08-02。

本文定义 Hadamard SDK、终端界面和桌面 GUI 之间哪些差异是有意设计。它描述当前产品契约，并不要求每一个 SDK 参数都必须对应一个按钮。

`hadamard-tui` 是唯一的交互式终端 Agent。`hadamard-gui`、`hadamard-app-server`、`hadamard-link-runtime` 等是桌面启动器或服务适配器，不是另一套终端 Agent。

## 第一层：共享运行时与命令契约

下列能力只要在某个产品中暴露，就必须保持相同语义：

- 模型执行、流式事件、Session、上下文统计、用量和中断；
- 工具、权限判断、Plan、Checkpoint、Diff、Memory 和 Goal；
- 生命周期 Hooks、MCP、Skills、Plugins、Agents、Teams、Bridge、Issues、Manager 和 Assistant；
- TUI 与 GUI 的顶级命令、二级命令、用法文本和补全行为；
- 统一事件、父子 Run 标识、脱敏和终止状态。

[`src/ui/commandSurface.ts`](../../src/ui/commandSurface.ts) 是两个交互产品的权威命令注册表。[`tests/cli-convergence.spec.ts`](../../tests/cli-convergence.spec.ts) 会拒绝“已注册但未同时接入 TUI 和 GUI”的命令或二级命令。

## 第二层：面向用户的产品控制面

TUI 与 GUI 都是第一层能力的产品化子集，同时可以保留适合各自媒介的功能：

- GUI 负责 Project 可视化、Agent Graph 画布、Workflow 树编辑、Automation 表单、桌面截图、自定义快捷键、应用更新、数据根迁移，以及桌面 Terminal/Git 面板；
- TUI 负责原生终端滚屏、键盘选择框和键盘优先的输入体验；
- 两者使用相同的 Slash Command 契约，但可以用不同布局展示结果；
- 产品控制面必须调用相同的运行时和持久化实现，不能维护第二套业务逻辑。

纯视觉或操作系统能力没有 TUI 版本，不属于一致性缺陷；命令含义、权限结果或持久化格式不一致，则属于一致性缺陷。

## 第三层：开发者与 Host API

SDK 有意保留最宽的参数面。以下能力不要求在 TUI 或 GUI 中逐项提供控制：

- Provider 适配器与能力声明；
- 自定义模型请求参数、工具、Schema、Middleware 和内容处理器；
- Runtime Services、存储适配器、Session CAS/Fork、事件 Sink、Tracing 和脱敏策略；
- 编排原语、Workflow Executor、Scheduler、Durable Store 和自定义后台 Runner；
- Node/Host 适配器、Sandbox、Transport 和兼容层。

只有当普通用户能够理解并稳定作出选择时，产品才应该增加控制项。可选采样参数可以留空，由当前 Provider/Runtime 使用自身默认值。SDK 新增专业参数不自动产生 UI 对齐义务。

## 当前能力矩阵

| 能力 | SDK | `hadamard-tui` | 桌面 GUI | 边界 |
|---|---|---|---|---|
| Run、Stream、中断、恢复 Session | 完整 API | 交互式 | 交互式 | 第一层，共享 Session 与事件语义 |
| Model、Effort、Output Style、Router | 完整 API | 命令和选择器 | Composer 与 Settings | 第一层行为，第二层展示 |
| Tools 与 Permissions | 自定义工具和策略 API | 权限对话框和预设 | 权限对话框和预设 | 第一层判断与审计语义 |
| Typed Lifecycle Hooks | 完整配置/运行时 API | 共享 `/hooks` 查看 | 完整编辑与查看 | 第一层运行时，GUI 编辑能力更强 |
| Agent Profiles 与执行树 | 完整 API | `/agents` 浏览 | 选择器、Settings、Project 执行视图 | 第一层数据，第二层视图 |
| Teams 与 Agent Workflow | 完整 API | `/team` 运行/挂载 | Agent Graph 与 Workflow 编辑器 | 共享 Team 定义和执行路径 |
| Automation Tasks | 调度与持久化 API | `/automation list/new` | 列表、编辑器和运行控制 | 同一任务文件；Scheduler 由 GUI/App Server 托管 |
| Dynamic Workflow Script | Trusted 兼容 API | `/workflows` | 共享 `/workflows` 命令 | 旧兼容/开发者能力，不等于 Agent Workflow 编辑器 |
| Bridge 与外部 CLI Runtime | 完整 API | `/bridge` | Composer 与 Settings | 共享配置和生命周期语义 |
| Projects、Issues、Manager、Assistant | 完整 Host API | 共享命令 | 产品页面与对话框 | 共享持久化和命令含义 |
| 桌面截图与自定义快捷键 | 适用时提供 Host API | 无桌面 UI | 原生控制 | 有意保留的第二层 GUI 能力 |
| Provider/Middleware/Storage/Executor 组合 | 完整 API | 不直接暴露 | 不直接暴露 | 有意保留的第三层 SDK 能力 |

## 两种 Workflow 格式

Hadamard 目前保留两种不同格式，并且不会静默互相转换：

1. **Agent Workflow** 是 `squadType: "workflow"` 的 `TeamDefinition`。它在 GUI 的 Agent 页面创建和编辑，通过共享 Team Member Runtime 执行，也是新建 Automation 时提供的目标。
2. **Dynamic Workflow Script** 是从 `.hadamard/workflows` 加载的可信 JavaScript。它继续通过 SDK 和 `/workflows` 提供兼容及开发者用途。

新建 Automation 会保存 `workflowSource: "agent"`。没有此标记的历史任务继续使用动态脚本运行时，因此升级不会把同名旧任务错误解释为 Agent Workflow。

## 变更规则

新增或修改能力时：

1. 先确定它属于哪一层，再决定是否增加 UI。
2. 共享命令及二级命令必须进入 `src/ui/commandSurface.ts`。
3. 两个产品必须复用相同的运行时、持久化、事件和权限契约。
4. 第一层命令增加 TUI/GUI 一致性测试；第二层控制面增加对应产品测试。
5. 对于有意保留的 SDK 专业能力，应在本文记录，而不是创建占位或空 UI。
