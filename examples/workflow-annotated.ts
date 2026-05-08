import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';
import type { AgentEvent } from 'actoviq-agent-sdk';

// ============================================================
// Workflow API — 逐参数讲解示例
//
// 阅读本示例时请配合教程 docs/en/07-workflow-orchestration.md
// 或 docs/zh/07-workflow-orchestration.md 的 "1.1 逐行讲解" 章节。
// ============================================================

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

// ============================================================
// 场景：对指定的 Git 仓库做一次发布前检查。
// 要求：
//   1. 仓库路径和分支名由调用者传入（而非写死）
//   2. 第一步做类型检查（只读，不能用写工具）
//   3. 第二步做 lint（依赖类型检查结果）
//   4. 第三步生成报告（依赖前两步，且用更快的模型）
//   5. 监听每个步骤的开始/结束事件
// ============================================================

const result = await sdk.workflow

  // ═══════════════════════════════════════════════════════════
  // .define(name, description)
  // ─────────────────────────────────────────────────────────
  // name:       工作流的唯一 ID。会出现在：
  //             - 事件回调的 event.workflowName 字段
  //             - 每个步骤的会话标题 → "{name}/{description}"
  //             - 日志输出
  //             取一个见名知意的名字即可，如 'release-check'。
  //
  // description: 工作流的用途说明。写入会话元数据，纯文档用途。
  //             不影响执行逻辑，但有助于日后排查。
  // ═══════════════════════════════════════════════════════════
  .define('release-check', '对指定仓库执行发布前类型检查和 lint')

  // ═══════════════════════════════════════════════════════════
  // .param(name, definition)
  // ─────────────────────────────────────────────────────────
  // 定义工作流级别的参数。这些参数由调用者在 .run() 时传入，
  // 在步骤 prompt 中通过 $PARAM_NAME（必须全大写）引用。
  //
  // name:          参数名。在 prompt 中用 $REPO_PATH 引用。
  // definition:
  //   type:        参数类型。目前支持 string/number/boolean/json。
  //   description: 参数说明。仅用于文档/可读性。
  //   required:    true 表示调用 .run() 时必须传入。
  //   default:     当 .run() 没传时使用的默认值。
  // ═══════════════════════════════════════════════════════════
  .param('REPO_PATH', {
    type: 'string',
    description: '要检查的仓库本地路径',
    required: true,
  })
  .param('BRANCH', {
    type: 'string',
    description: '要检查的分支名',
    default: 'main',
  })

  // ═══════════════════════════════════════════════════════════
  // .model(model) — 所有步骤的默认模型，单步可通过 opts.model 覆盖
  // ═══════════════════════════════════════════════════════════
  .model('claude-sonnet-4-6')

  // ═══════════════════════════════════════════════════════════
  // .systemPrompt(prompt) — 所有步骤的默认系统提示词，单步可覆盖
  // ═══════════════════════════════════════════════════════════
  .systemPrompt('你是一个 DevOps 工程师。只报告检查结果，不闲聊。语言：中文。')

  // ═══════════════════════════════════════════════════════════
  // .step(id, description, prompt, opts?)
  //
  // 三个必传参数：
  //   id          — 步骤唯一标识。用于 dependsOn、$steps.<id>.text、结果查找。
  //   description — 人类可读的描述。用于会话标题 "{workflow}/{description}"
  //                 和事件回调 event.stepName。可以为空字符串 ''。
  //   prompt      — 发送给 AI 的实际提示词。支持变量插值。
  //
  // opts 可选字段：
  //   dependsOn      — 依赖的步骤 ID 列表
  //   allowedTools   — 限制此步骤可用的工具名称
  //   tools          — 此步骤专属的额外工具定义
  //   mcpServers     — 此步骤专属的 MCP 服务器
  //   skillDirectories — 此步骤额外加载 skill 的目录
  //   model          — 覆盖模型
  //   systemPrompt   — 覆盖系统提示词
  //   mode           — 'react'（默认，完整工具循环）| 'single'（单次回答，不调用工具）
  // ═══════════════════════════════════════════════════════════

  // ── 步骤 1: typecheck ─────────────────────────────────────
  .step(
    'typecheck',         // id: 依赖引用和变量插值的标识
    '运行类型检查',       // description: 显示名称，会话标题 "release-check/运行类型检查"
    '对位于 $REPO_PATH 的仓库执行 tsc --noEmit，检查 $BRANCH 分支是否有类型错误。',
    {
      allowedTools: ['read', 'glob', 'grep'],  // 只读，不允许修改文件
    },
  )

  // ── 步骤 2: lint ──────────────────────────────────────────
  .step(
    'lint',              // id: $steps.lint.text 中引用
    '运行代码检查',       // description: 面向人类的显示名称
    '对 $REPO_PATH 的 $BRANCH 分支运行 ESLint。类型检查结果：$steps.typecheck.text',
    {
      dependsOn: ['typecheck'],  // 依赖步骤 1，等它完成才执行
      // 没有 allowedTools → 继承 SDK 默认权限
      // 没有 model → 继承全局 model('claude-sonnet-4-6')
    },
  )

  // ── 步骤 3: report ────────────────────────────────────────
  .step(
    'report',            // id: 结果通过 result.steps.find(s => s.id === 'report')
    '生成检查报告',       // description: 事件回调中 event.stepName 显示此值
    '请根据以下信息生成 $BRANCH 分支的发布前检查报告：\n'
      + '类型检查：$steps.typecheck.text\n'
      + 'Lint 检查：$steps.lint.text',
    {
      dependsOn: ['typecheck', 'lint'],  // 等前两步都完成
      model: 'claude-haiku-4-5',         // 覆盖全局模型——报告用更快模型
      systemPrompt: '你是一个技术报告生成器。只输出 markdown 格式的报告，不要对话。',
      // 也可以在此传入 mcpServers、tools、skillDirectories 等
    },
  )

  // ═══════════════════════════════════════════════════════════
  // .run(params, options?)
  //
  // params: 传给 .param() 定义的参数。REPO_PATH 必传，BRANCH 可选。
  // options.onEvent: 事件回调，监听四种事件。
  // ═══════════════════════════════════════════════════════════
  .run(
    { REPO_PATH: '/home/user/project', BRANCH: 'release/v2.0' },
    {
      onEvent: (event: AgentEvent) => {
        switch (event.type) {
          case 'workflow.start':
            console.log(`[开始] 工作流 "${event.workflowName}"，共 ${event.stepCount} 步`);
            break;
          case 'step.start':
            console.log(`  [步骤开始] ${event.stepName}`);
            break;
          case 'step.done':
            console.log(`  [步骤完成] ${event.stepId} → ${event.status} (${event.durationMs}ms)`);
            break;
          case 'workflow.done':
            console.log(`[结束] 状态=${event.status}，总耗时 ${event.durationMs}ms`);
            break;
        }
      },
    },
  );

// ═══════════════════════════════════════════════════════════
// 结果解读
// ═══════════════════════════════════════════════════════════

console.log('\n=== 工作流执行结果 ===');
console.log('状态:', result.status);
console.log('总耗时:', result.durationMs, 'ms');
console.log('输出摘要:', result.text.slice(0, 200));

console.log('\n步骤详情:');
for (const step of result.steps) {
  console.log(`  ${step.id} (${step.name})`);
  console.log(`    状态: ${step.status} | 耗时: ${step.durationMs}ms`);
  console.log(`    会话ID: ${step.sessionId}`);
  if (step.error) console.log(`    错误: ${step.error}`);
  if (step.toolCalls.length > 0) console.log(`    工具: ${step.toolCalls.join(', ')}`);
}

// ═══════════════════════════════════════════════════════════
// 失败恢复
// ═══════════════════════════════════════════════════════════
const failed = result.steps.find(s => s.status === 'failed');
if (failed) {
  console.log(`\n步骤 "${failed.name}" 失败，正在恢复会话重试...`);
  const session = await sdk.resumeSession(failed.sessionId);
  const retry = await session.send('上一次执行失败了，请重试。');
  console.log('重试结果:', retry.text.slice(0, 200));
}
