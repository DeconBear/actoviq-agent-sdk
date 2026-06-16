# 19 — Benchmark 测试框架

## 架构

Benchmark 测试框架通过在隔离的工作区中运行 SDK 实例并评分确定性的最终状态来评估 agent 行为。它比较 Hadamard SDK、actoviq-bridge-sdk 和官方 Claude Agent SDK。

位置：`bench/*`

### 设计原则

- **隔离工作区**：每次试验在复制的临时目录中运行
- **确定性评分器**：最终状态检查（测试通过、文件内容、事件计数），而非提示词合规
- **不强制配方**：agent 提示词包含任务，而非解决方案
- **行为信号**：可选期望（最少子代理调用、最多工具错误）仅影响行为分数

### 文件

| 文件 | 角色 |
|---|---|
| `bench/runner.ts` | 主 benchmark 运行器 |
| `bench/run-parity.ts` | 三路对比运行器 |
| `bench/types.ts` | Benchmark 用例、报告、评分器类型 |
| `bench/agents/clean-sdk-runner.ts` | Hadamard SDK benchmark 封装 |
| `bench/agents/bridge-sdk-runner.ts` | Bridge SDK benchmark 封装 |
| `bench/agents/official-claude-sdk-runner.ts` | 官方 Claude Agent SDK 封装 |
| `bench/cases/` | Benchmark 用例定义（JSON） |
| `bench/fixtures/` | 隔离工作区夹具 |

### 评分维度

| 维度 | 权重 | 测量内容 |
|---|---|---|
| **确定性** | 主要 | 文件内容、测试通过/失败、精确输出匹配 |
| **行为** | 次要 | 子代理调用、skill 使用、工具错误率 |
| **轨迹** | 诊断 | 请求计数、token 用量、耗时 |

### 评分器类型

| 评分器 | 检查内容 |
|---|---|
| `file_contains` | 文件包含特定字符串 |
| `file_equals` | 文件与预期内容完全匹配 |
| `test_passes` | `node test.mjs` 退出码 0 |
| `command_output` | Shell 命令输出匹配模式 |
| `no_file_exists` | 文件不存在（安全检查） |

### 行为期望

```typescript
interface BehaviorExpectations {
  minSubagentCalls?: number;         // 最少 Agent/Task 调用次数
  minBackgroundSubagentCalls?: number;
  maxToolErrors?: number;
  requiredSkillNames?: string[];
  minSkillUseCount?: number;
}
```

这些仅影响**行为分数**——不替代确定性评分器，也不强制提示词中的工具序列。

### Budget 传播

```typescript
// 用例声明 budget.maxTurns：
//   → Hadamard SDK: ACTOVIQ_BENCH_MAX_TOOL_ITERATIONS 环境变量
//   → Bridge SDK: --max-turns CLI 标志
//   → 官方 SDK: maxTurns 选项
// 未声明 budget：
//   → 所有运行时无限制运行（Infinity）
```

---

## v0.5.0: DRACO Benchmark 集成

### DRACO 基准

Perplexity AI 的 [DRACO](https://arxiv.org/abs/2602.11685)（Deep Research Accuracy, Completeness, and Objectivity）评测 100 个深度研究任务，评分四维度：

| 维度 | 权重 | 评估内容 |
|---|---|---|
| Factual Accuracy | 70% | 可验证事实正确性（负向惩罚） |
| Breadth & Depth | 15% | 分析完整性和信息整合 |
| Presentation Quality | 8% | 清晰度、结构、客观性 |
| Citation Quality | 7% | 引用可靠性和来源多样性 |

### 三向对比评测

SDK 支持三种 DRACO 评测模式：

| 模式 | 说明 |
|---|---|
| Single (Hadamard) | 单 Agent + TavilySearch |
| Team (Hadamard) | Agent + TavilySearch + expert-panel tool |
| Official (Claude Code) | Claude Code CLI 基准 |

### DeepSeek 重评系统

DRACO 的严格 PASS/FAIL rubric 对自由格式答案不友好。v0.5.0 引入了 DeepSeek-v4-pro 作为独立 judge 的重评方案：

- 1-10 分制（替代 PASS/FAIL 二元评分）
- 五维度：Factual / Breadth / Presentation / Citation / Overall
- JSON 结构化输出，重试机制
- 对比 DRACO 和 DeepSeek judge 的结果一致性

### 关键发现

DRACO 评分对 agent 迭代次数敏感（15 轮不足以覆盖 ~40 条标准），但对答案质量不敏感（5286 chars 精炼答案 vs 17661 chars 冗长答案）。建议配合多元化评测方案。

### 效率评分

v0.5.0 新增工具调用效率评分：
- `efficiency = max(0, 1 - toolCalls / 10)` 
- 0 次工具调用 = 1.0，10+ 次 = 0
- 最终分 = DRACO × 0.8 + efficiency × 0.2
