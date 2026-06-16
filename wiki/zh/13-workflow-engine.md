# 13 — 工作流引擎（DAG）

## 架构

DAG 工作流引擎执行声明式的、JSON 定义的工作流，其中步骤具有显式依赖关系。它使用拓扑排序确定执行顺序，并在每个层级内并行运行独立的步骤。

位置：`src/workflow/workflowEngine.ts`, `src/workflow/workflowBuilder.ts`

### 与动态工作流的关系

DAG 引擎（`WorkflowEngine`）是**声明式**工作流系统（v0.2.0）。动态工作流（计划中的 v0.5.0）将是**基于脚本**的系统。两者将共存——DAG 适用于简单静态图，动态适用于编程式编排。

## 执行流程

```
workflowEngine.run(definition, params, options)
    │
    ├── 1. 解析参数（默认值 + 类型强制）
    ├── 2. 拓扑排序（Kahn 算法）
    │      • 构建依赖图 → BFS → 分组为层级
    │      • 检测循环 → 抛出异常
    ├── 3. 逐层执行
    │      for each level:
    │        ├── 过滤：跳过依赖失败的步骤
    │        ├── Promise.all(可运行的步骤)
    │        │   └── 每个步骤：变量插值 → 创建会话 → send → 重试
    │        └── 标记失败的步骤
    ├── 4. 聚合结果（completed/partial/failed）
    └── 5. 返回 WorkflowRunResult
```

### 变量插值

```typescript
// $steps.<id>.text → 前一步骤的输出文本
// $steps.<id>.toolCalls → 逗号分隔的工具调用名称
// $PARAM_NAME → 工作流参数值
```

### 步骤模式

| 模式 | 工具行为 | 用例 |
|---|---|---|
| `react`（默认） | 完整 ReAct 循环 | 代码修改、研究、调试 |
| `single` | `tool_choice: "none"`，一次性回答 | 分类、摘要 |

### 重试与超时

步骤可以声明 `retries`（默认 0）和 `timeoutMs`。失败时最多重试 `retries` 次，使用同一会话（上下文保留）。

### `WorkflowBuilder` — 流式 DSL

```typescript
await sdk.workflow
  .define('release-check', '验证发布准备')
  .step('test', '运行测试', '运行测试套件并报告结果。')
  .step('lint', '运行检查', '检查代码库。', { dependsOn: ['test'] })
  .step('build', '构建包', '构建并验证包。', { dependsOn: ['lint'] })
  .run();
```

### 拓扑排序 — Kahn 算法

```typescript
function topologicalSort(steps): WorkflowStepDefinition[][] {
  // 1. 构建入度表 + 邻接表
  // 2. 将所有入度为 0 的节点入队
  // 3. BFS：处理队列，减少依赖节点的入度
  // 4. 按 BFS 层级分组
  // 5. 检测循环：如果已处理数 < 总步骤数 → 错误
  return levels;
}
```

---

## v0.5.0: Dynamic Workflows（动态工作流）

新增的 JS 脚本编排层，与 DAG 工作流共存。位置：`src/workflow/workflowScriptRuntime.ts`

### 架构

```
用户 JS 脚本
    │
    ▼
WorkflowScriptRuntime
    ├── vm.Script (沙箱，零 fs/net/process 访问)
    ├── Host Bridge (消息传递：脚本 ↔ 真实 SDK API)
    ├── 缓存层 (确定性 key → agent 回复重放)
    └── 进度发射器 (EventEmitter → /workflows UI)
```

### 脚本 API

```javascript
export const meta = { name: 'audit', description: 'Security audit',
  phases: [{ title: 'Discover' }, { title: 'Verify' }] };

phase('Discover');
const endpoints = await agent('Find all API endpoints.', { schema: ENDPOINT_SCHEMA });

phase('Verify');
const verified = await pipeline(endpoints.routes,
  ep => agent(`Audit ${ep.path}`, { schema: AUDIT_SCHEMA }),
  (audit, ep) => audit.issues ? agent(`Fix ${ep.path}`, { isolation: 'worktree' }) : null
);

log(`Found ${verified.filter(Boolean).length} issues.`);
```

### 核心原语

| 原语 | 行为 |
|---|---|
| `agent(prompt, opts?)` | 生成子代理，返回文本或结构化输出 |
| `parallel(thunks[])` | Barrier：所有 thunk 完成，失败 → null |
| `pipeline(items, ...stages)` | 无 barrier：逐项流式通过所有阶段 |
| `phase(title)` | 分组后续 agent 到命名阶段 |
| `log(message)` | 发射 narrator 消息 |
| `budget.total/spent()/remaining()` | Token 预算跟踪 |
| `args` | 参数化调用（数组/对象作为真实 JS 值） |

### 关键设计

- **Host Bridge**：沙箱 `vm.Script` 零 fs/net 访问，`agent()` 调用通过消息传递到真实 SDK
- **缓存键归一化**：sorted JSON keys → 确定性缓存命中
- **Pipeline 错误隔离**：单 item 失败不影响其他 items，错误记录在 `workflowResult.errors[]`
- **Schema 强制** (append mode)：当 `opts.schema` 设置时，注入 StructuredOutput 工具，最多重试 3 次
- **并发上限**：全局 AgentPool，min(16, cpuCores - 2)

### 持久化

```bash
~/.actoviq/workflows/<name>.js     # 个人
.actoviq/workflows/<name>.js       # 项目（覆盖个人）
```

禁用开关：`ACTOVIQ_DISABLE_WORKFLOWS=1` 或 `disableWorkflows: true` 在 settings.json

### TUI/REPL 集成

```
/workflows list           — 列出已保存的工作流
/workflows run <name>     — 执行工作流脚本
```
