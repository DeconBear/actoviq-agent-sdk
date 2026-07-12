# ADR-006：Trusted / Untrusted Workflow Executor

- 状态：Accepted；local-process 不是强安全沙箱
- 日期：2026-07-11
- 决策范围：`actoviq-agent-sdk/workflow`
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧 `WorkflowScriptRuntime` 使用 `node:vm` 运行动态 JavaScript。Node 官方明确说明 `node:vm` 不是安全机制。把外部生成或上传的脚本放入同一进程，会暴露宿主环境、secret、filesystem、network 和 process 能力，也会把无限循环/大输出带入 runtime。

另一方面，仓库内或用户明确安装的 trusted workflow 仍需要兼容执行路径。系统必须把“受信任兼容执行”与“非受信任隔离执行”明确分开，而不是用一个含混的 `sandbox` 开关。

## 决定

### 1. 每次执行必须显式声明 trust tier

`WorkflowExecutionRequest` 是判别联合：

- `trust: 'trusted'`：只进入 `TrustedWorkflowExecutor`；
- `trust: 'untrusted'`：只进入 `SandboxWorkflowExecutor`，并要求绝对 `workspaceDir`。

没有 trust、未知 trust 或 untrusted 但未配置 sandbox executor 均失败。不得根据文件路径、调用者名称或 prompt 自动提升信任。

### 2. node:vm 只用于 trusted compatibility

`TrustedCompatibilityWorkflowExecutor` 在进程内使用 `node:vm`，有 finite VM/wall timeout、JSON 输入输出限制和 capability allowlist。它的名字和文档必须包含 trusted/compatibility，不得宣称是安全沙箱。

Trusted 表示 host 接受脚本拥有与宿主进程同等级风险，不表示脚本“已被 vm 安全隔离”。

### 3. Local isolated process 是有限隔离层

`LocalIsolatedProcessWorkflowExecutor`：

- 使用独立 Node process；
- `env: {}`，不继承宿主环境变量；
- `shell: false`、hidden window；
- 启用 Node permission model，默认不给 fs/child process/worker/addon/WASI grant；
- 仅以有界 NDJSON/JSON-RPC 调用 allowlisted capability；
- 限制 wall time、单消息、总输出和 protocol message 数；
- abort/超时终止并回收 child。

它用于防止 ambient capability 和误操作，但不承诺抵抗 Node/V8/OS 漏洞、同用户旁路、内核攻击或恶意 multi-tenant code。

### 4. 真正对抗性 workload 使用 container/remote adapter

`SandboxWorkflowExecutor` 保留 `isolation: 'container' | 'remote'` 扩展点。对外部不可信、多租户或高价值 secret 场景，host 必须使用能约束 CPU、memory、wall time、filesystem mount、network egress 和 identity 的 container/remote 实现。

### 5. Capability 是唯一授权通道

Executor constructor 注册 capability handlers；每次 request 只选择其子集，默认空。Capability 输入输出必须是有限 JSON 值，handler 继承 abort signal，并由 host 再做 tenant/workspace/policy 校验。脚本声明 capability 不是授权。

## 拒绝的方案

### 把 node:vm 继续称为 sandbox

拒绝。会产生错误安全承诺，与 Node 官方边界不符。

### 默认信任动态脚本

拒绝。信任必须由安装/审核流程显式给出，外部输入默认 untrusted。

### local child 继承 process.env 后再删几个 key

拒绝。denylist 易漏 secret；采用空环境和显式 capability。

### 允许脚本直接 import fs/net/child_process

拒绝。文件、网络和进程操作必须经过 host capability/policy，或放入更强 sandbox。

### 把 local-process 宣称为 adversarial sandbox

拒绝。进程边界与 permission model 降低风险，但不是容器、VM 或远程隔离的替代品。

## 兼容影响

- 旧 `WorkflowScriptRuntime.execute()` 现在要求 `trust: 'trusted'`；仓库内 CLI/TUI/GUI workflow 调用需要显式标注 trusted。
- 未明确 trust 的外部脚本从“可能运行”变为拒绝，这是有意的安全收紧。
- 新 workflow subpath 的 source contract 要求表达式求值为 `(context) => JsonValue | Promise<JsonValue>`。
- Windows 上 local child bootstrap 有命令行长度保护；超过安全长度会配置失败，而非降级到同进程。

## Runtime 成本

- Trusted compatibility：同进程 context/script 创建与 JSON 序列化成本低，但风险由 host 承担。
- Local isolated process：每次 run 产生一个 Node process、stdio/JSON-RPC 和启动延迟；安全优先于吞吐。
- 空环境与 permission model 会让依赖 ambient env/fs 的旧脚本失败，需要改为 capability。
- byte/message limit 需要编码、计数和 clone；这是 bounded resource 的必要成本。

## 测试证据

- [`tests/workflow-executor-v2-security.spec.ts`](../../tests/workflow-executor-v2-security.spec.ts)：显式 trust routing、默认拒绝 untrusted、空环境、禁止 fs/net/process access、capability allowlist、timeout/abort、message/output limit、child cleanup。
- [`tests/dynamic-workflow.spec.ts`](../../tests/dynamic-workflow.spec.ts) 与 [`tests/workflow-advanced.spec.ts`](../../tests/workflow-advanced.spec.ts)：旧 trusted workflow 兼容与 deadline。

这些测试不构成对 Node/V8 sandbox escape 的证明。对抗性场景的 container/remote executor 和相应 penetration test 仍由部署方提供。

## 回滚方式

1. Trusted 仓库 workflow 可回到旧 compatibility executor，但仍必须保留 finite deadline。
2. 不得通过回滚把 untrusted 请求自动改成 trusted；若没有安全 executor，应继续拒绝。
3. Local executor 故障时，停止接收新 untrusted run，等待/kill active child，并保留审计事件。
4. Capability rollout 可逐个撤回；默认空 capability 保持可用。
5. 若 container/remote adapter 回滚，路由必须 fail closed，不能静默回退 local/trusted。

## 参考

- [Node.js `node:vm` 安全边界](https://nodejs.org/api/vm.html)
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deer-flow`
- 本地参考：`E:\BaiduSyncdisk\research\Programming_Development\procontributor\claude_\deepagents`
