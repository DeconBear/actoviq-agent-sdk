# ADR-009：Node 22 / 24 支持矩阵

- 状态：Accepted（Node 22.13+ / 24 contract 已对齐）
- 日期：2026-07-11
- 决策范围：SDK/runtime、Node adapters、Electron/CI
- 对应规划：[SDK 架构审计与优化规划](../zh/08-sdk-architecture-audit-and-optimization-plan.md)

## 上下文

旧 package 曾承诺 Node >=18，但新实现使用 `AbortSignal.any/throwIfAborted`、现代 ESM、Node permission model 和可选 `node:sqlite`。继续支持 EOL 运行时会扩大 polyfill、条件分支、CI 和安全维护成本。SDK 同时包含 Electron、node-pty 等可选 native 组件，需要把纯 core 与 Node/desktop adapter 的支持范围区分开。

## 决定

### 1. 支持的 major

SDK/runtime 与 Electron desktop build 支持 Node 22.13+ 和 Node 24 LTS。Node 18/20 不属于新版本支持目标。`package.json#engines`、CI、文档和实际 API 必须一致。

### 2. CI 矩阵

- Linux：Node 22、24，typecheck/test/build；
- Windows：Node 22、24，typecheck/test/build；
- macOS：Node 22、24 nightly 或手动 workflow；
- Linux 最低版本：精确 Node 22.13.0、24.0.0，typecheck/test/build；
- package dry-run：至少 Node 22；
- Electron/native PTY：独立 smoke matrix，实验性架构必须显式 non-blocking。

当前 `.github/workflows/ci.yml` 已表达上述主矩阵；这只说明配置存在，不等于远端每个 job 已在本提交成功，发布仍要检查 CI run 结果。

### 3. Subpath 细分约束

- `/core`、`/providers`、`/runtime`、`/events`、`/orchestration`、`/profiles`：Node 22/24 contract。
- `/node` 的默认 SQLite driver 动态加载 `node:sqlite`；当前实现要求 Node 22.13+ 或调用方注入 `SqliteDriverFactory`。Node 22.5–22.12 虽包含该模块，但必须由宿主进程显式传 `--experimental-sqlite`，不属于默认支持契约。
- `/workflow` 的 local isolated process 要求 Node 22+ permission model。
- Electron、node-pty、xterm 是 optional/native surface，兼容性以 desktop build/smoke matrix 为准。

当前 `engines` 已收敛为 `^22.13.0 || ^24.0.0`，与无需宿主 flag 的默认 SQLite driver 最低版本一致。Node 22 使用 `--experimental-permission`，Node 24 使用稳定的 `--permission`；local isolated workflow executor 会按 major 选择对应 flag。

### 4. Support 定义

“支持”表示在对应矩阵中安装、typecheck、test、build 通过，并对安全/严重回归提供修复；不表示所有 optional native dependency 在每个 CPU 架构都有预编译包。未在矩阵中的 runtime/OS 只能 best effort。

## 拒绝的方案

### 继续承诺 Node >=18

拒绝。会要求大量 polyfill/分支，并依赖已结束维护的 runtime。

### 只测试开发者当前 Windows/Node 版本

拒绝。Filesystem、signal、child process、path 与 native dependency 跨平台差异显著。

### 将 node:sqlite 静态 import 到 package root

拒绝。会让不使用存储的消费者也受小版本和 experimental availability 影响。

### 把 macOS 完全移出 CI

拒绝。至少 nightly 可发现 path/permission/child process 差异，同时控制每次 PR 成本。

### 将实验性 arm64 PTY job 作为所有发布的唯一阻塞门禁

拒绝。Runner/native prebuild 可用性不同；应单独标明实验性，同时保留 x64 blocking smoke。

## 兼容影响

- Node 18/20 用户需要升级 Node 或继续停留在旧 SDK 版本；不能通过 compat façade绕过 runtime engine requirement。
- 所有 1.0 package 用户在 Node 22 上都需要满足 22.13+；自定义 SQLite driver 不会放宽 package engine contract。
- CI/package manager 可能因 `engines` 拒绝安装 unsupported major。
- Desktop 发布必须与其 bundled Electron Node ABI 验证，不能仅凭系统 Node 版本推断。

## Runtime 成本

- 收敛 major 减少 polyfill、分支和测试成本，并允许使用 native abort/permission/sqlite 能力。
- 多 OS × 两个 Node major及两个精确最低版本增加 CI 时间；macOS nightly 降低 PR latency。
- Dynamic import 避免未使用 `/node` 时加载 SQLite。
- Native PTY/Electron 构建成本独立于纯 SDK，不能混成最小 runtime cold-start 成本。

## 测试证据

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)：精确最低 Node 22.13.0/24.0.0、Node 22/24 Linux/Windows、macOS nightly、package dry-run。
- [`tests/storage-v2.spec.ts`](../../tests/storage-v2.spec.ts)：默认 Node SQLite driver 的行为（在具备模块的运行时）。
- [`tests/workflow-executor-v2-security.spec.ts`](../../tests/workflow-executor-v2-security.spec.ts)：Node permission-model local executor。
- `scripts/pty-spike`：desktop native smoke harness。
- [SDK 1.0 实施与验收报告](../zh/12-sdk-1.0-implementation-and-verification-report.md)：本地 Node 22/24 typecheck/build/full suite 与 package dry-run 结果。

本地 `npm pack --dry-run` 已通过；外部发布仍必须附实际 CI run URL/结果。文档/配置文件和本机结果不能替代远端 OS matrix 证据。

本地负向 floor probe 使用真实 Node 22.5.0：typecheck 通过，但所有默认 SQLite 场景以 `ERR_UNKNOWN_BUILTIN_MODULE` 失败，证明旧 `^22.5.0` 声明不成立。Node 官方历史记录确认 `node:sqlite` 从 22.13.0 起不再要求 `--experimental-sqlite`；因此提高下限是修复支持事实，不是任意缩窄兼容范围。

## 回滚方式

1. 如果 Node 24 回归，临时把发布标记为 Node 22 recommended，但不得偷偷修改已发布 engines；修复后恢复矩阵。
2. `/node` SQLite 不可用时，注入 tested `SqliteDriverFactory` 或停用该 subpath；不要回退为未加锁 JSON writer。
3. Desktop native failure 可暂停该平台 artifact，不影响纯 SDK 的已验证平台。
4. Engine 范围变更通过新版本发布；扩大范围需要新增 CI，缩小范围按 breaking/support policy 公告。
5. 保留最后一个通过完整矩阵的 release artifact/lockfile，便于回滚。

## 参考

- [Node.js SQLite history](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Node.js `node:vm`](https://nodejs.org/api/vm.html)
- [支持矩阵与版本策略](../zh/10-support-security-semver-and-failure-model.md)
