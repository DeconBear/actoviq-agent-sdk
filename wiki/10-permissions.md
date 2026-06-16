# 10 — Permissions

## Architecture

The permissions system decides whether a tool call is allowed, denied, or
requires user approval. It evaluates a priority-ordered chain of rules,
safety checks, mode defaults, and interactive approvers.

Location: `src/runtime/actoviqPermissions.ts`

### Permission Modes

| Mode | Behavior |
|---|---|
| `bypassPermissions` | All tools allowed, no prompts |
| `acceptEdits` | Read-only + file edits allowed; destructive tools require approval |
| `default` | Read-only allowed; mutating tools require approval |
| `plan` | Read-only allowed; ALL mutating tools denied (plan-first workflow) |

## Module Design

### Decision Pipeline

```
decideActoviqToolPermission(input)
    │
    ├── 1. Check deny rules (wildcard match against toolName + input)
    │       → match found → DENY
    │
    ├── 2. Safety check (checkSafety)
    │       • Path traversal detection
    │       • Protected directory access
    │       → blocked → DENY
    │
    ├── 3. Tool's own checkPermissions callback
    │       → 'deny'  → DENY
    │       → 'allow' → ALLOW
    │       → 'ask'   → defer to approver
    │
    ├── 4. Check ask rules
    │       → match found → defer to approver
    │
    ├── 5. Tool requires user interaction?
    │       → yes → defer to approver
    │
    ├── 6. bypassPermissions mode?
    │       → yes → ALLOW
    │
    ├── 7. Check allow rules
    │       → match found → ALLOW
    │
    ├── 8. Tool is read-only?
    │       → yes → ALLOW (in default/acceptEdits/plan modes)
    │
    ├── 9. acceptEdits mode + file edit tool?
    │       → yes → ALLOW
    │
    ├── 10. Classifier callback
    │       → allow/deny/ask based on custom logic
    │
    ├── 11. canUseTool callback
    │       → allow/deny/ask based on custom logic
    │
    ├── 12. plan mode + destructive tool?
    │       → yes → DENY
    │
    ├── 13. Destructive tool without approver?
    │       → DENY
    │
    └── 14. Destructive tool with approver?
            → defer to approver
```

### Rule Matching

Rules use wildcard patterns (glob-style `*` matching):

```typescript
interface ActoviqPermissionRule {
  toolName: string;      // Wildcard pattern (e.g., "Bash*", "*Edit*")
  behavior: 'allow' | 'deny' | 'ask';
  matcher?: string;      // Optional: match against JSON.stringify(input)
  source?: string;       // Origin of the rule (for audit)
}

// Pattern matching
function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.split('*').map(escape).join('.*')}$`,
    'i',  // case-insensitive
  );
}
```

### File Edit Tools

```typescript
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
```

In `acceptEdits` mode, these tools are explicitly allowed regardless of
destructive classification. This matches Claude Code's behavior where file
edits are pre-approved in accept-edits mode.

## Code Details

### `decideActoviqToolPermission()` Core Logic

```typescript
export async function decideActoviqToolPermission(
  input: PermissionInput,
): Promise<ActoviqPermissionDecision> {
  // 1. Deny rules take priority
  const denyRule = input.rules.find(r =>
    r.behavior === 'deny' && matchesRule(r, input.publicName, input.toolInput));
  if (denyRule) return decision(input, 'deny', `Denied by rule ${denyRule.toolName}`, 'rule');

  // 2. Safety checks
  const safety = checkSafety({
    toolName: input.toolName, publicName: input.publicName,
    toolInput: input.toolInput, workDir: input.workDir,
  });
  if (safety.blocked) return decision(input, 'deny', safety.reason, 'mode');

  // 3. Tool's own permission logic
  if (input.adapter?.checkPermissions) {
    const result = await input.adapter.checkPermissions({ mode, runId, sessionId });
    if (result === 'deny') return decision(input, 'deny', '...', 'mode');
    if (result === 'allow') return decision(input, 'allow', '...', 'mode');
    if (result === 'ask') return resolveActoviqAskPermission(input, baseDecision);
  }

  // 4-14. Continue through remaining checks...
  // (see decision pipeline above)
}
```

### `Decision` Object

```typescript
interface ActoviqPermissionDecision {
  toolName: string;
  publicName: string;
  behavior: 'allow' | 'deny';
  reason: string;
  source: 'rule' | 'mode' | 'classifier' | 'canUseTool' | 'approver';
  matchedRule?: string;
  timestamp: string;
}
```

### Approver Resolution

```typescript
async function resolveActoviqAskPermission(
  input: PermissionInput,
  baseDecision: ActoviqPermissionDecision,
): Promise<ActoviqPermissionDecision> {
  if (!input.approver) {
    return { ...baseDecision, behavior: 'deny',
      reason: 'Approval required but no approver available.' };
  }

  const approval = await input.approver({
    runId, sessionId, workDir, toolName, publicName,
    input: toolInput, prompt, iteration, mode,
    proposedBehavior: 'ask', reason: baseDecision.reason,
    source: baseDecision.source, matchedRule: baseDecision.matchedRule,
  });

  return decision(input,
    approval?.behavior === 'allow' ? 'allow' : 'deny',
    approval?.reason ?? 'Approval denied.',
    'approver');
}
```

### Safety Checks

`src/runtime/safetyChecks.ts` provides path-based safety validation:
- Path traversal detection (`../` escape attempts)
- Protected directory access (system directories, `.git` internals)
- Workspace boundary enforcement

### Session Permission Rules

Permission rules can be set per-session and are persisted in
`StoredSession.metadata`:

```typescript
metadata: {
  __actoviqSessionPermissions: {
    mode: 'default',
    rules: [
      { toolName: 'Bash*', behavior: 'ask', source: 'session' },
      { toolName: 'Read', behavior: 'allow', source: 'session' },
    ],
  }
}
```
