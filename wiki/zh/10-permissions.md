# 10 — 权限系统

## 架构

权限系统决定工具调用是被允许、拒绝还是需要用户批准。它评估一个按优先级排序的规则链、安全检查、模式默认值和交互式审批器。

位置：`src/runtime/actoviqPermissions.ts`

### 权限模式

| 模式 | 行为 |
|---|---|
| `bypassPermissions` | 所有工具允许，无提示 |
| `acceptEdits` | 只读 + 文件编辑允许；破坏性工具需要审批 |
| `default` | 只读允许；变更工具需要审批 |
| `plan` | 只读允许；所有变更工具拒绝（先计划后执行） |

### 决策管道（14 步）

```
decideActoviqToolPermission(input)
    ├── 1. 检查 deny 规则（通配符匹配）
    ├── 2. 安全检查（路径遍历、受保护目录）
    ├── 3. 工具自身的 checkPermissions 回调
    ├── 4. 检查 ask 规则
    ├── 5. 工具需要用户交互？
    ├── 6. bypassPermissions 模式？→ 允许
    ├── 7. 检查 allow 规则
    ├── 8. 工具是只读的？→ 允许
    ├── 9. acceptEdits + 文件编辑工具？→ 允许
    ├── 10. 分类器回调（classifier）
    ├── 11. canUseTool 回调
    ├── 12. plan 模式 + 破坏性工具？→ 拒绝
    ├── 13. 破坏性工具无审批器？→ 拒绝
    └── 14. 破坏性工具有审批器？→ 请求审批
```

### 规则匹配

规则使用通配符模式（glob 风格 `*` 匹配）：

```typescript
interface ActoviqPermissionRule {
  toolName: string;      // 通配符模式（如 "Bash*", "*Edit*"）
  behavior: 'allow' | 'deny' | 'ask';
  matcher?: string;      // 可选：匹配 JSON.stringify(input)
}
```

### 文件编辑工具

```typescript
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
```

在 `acceptEdits` 模式下，这些工具被显式允许。

### 审批器解析

```typescript
async function resolveActoviqAskPermission(input, baseDecision) {
  if (!input.approver) {
    return { ...baseDecision, behavior: 'deny' };
  }
  const approval = await input.approver({...});
  return approval?.behavior === 'allow' ? allow : deny;
}
```
