# 02 — 配置管道

## 架构

配置管道从严格的优先级链中解析所有运行时设置。不自动检测——每个值都有确定来源。

位置：`src/config/resolveRuntimeConfig.ts:61`

### 解析链

```
1. CreateAgentSdkOptions     (编程方式，最高优先级)
2. process.env               (ACTOVIQ_* 变量)
3. ~/.actoviq/settings.json  (→ env 块)
4. 硬编码默认值               (最低优先级)
```

### 模型分级（Model Tiers）

用户可以使用分级别名（`min`、`medium`、`max`）代替具体模型 ID：

```typescript
const ACTOVIQ_MODEL_TIERS = ['min', 'medium', 'max'] as const;

function resolveActoviqModelReference(model: string, tiers: ActoviqModelTierConfig): string {
  if (isActoviqModelTier(model)) {
    const resolved = tiers[model];
    if (!resolved) throw new ConfigurationError(`No model configured for tier "${model}"`);
    return resolved;
  }
  return model;
}
```

分级映射来自环境变量：`ACTOVIQ_DEFAULT_MIN_MODEL`、`ACTOVIQ_DEFAULT_MEDIUM_MODEL`、`ACTOVIQ_DEFAULT_MAX_MODEL`。

### 会话目录

`src/config/projectSessionDirectory.ts`

会话按工作区隔离，通过路径编码：

```typescript
function encodeActoviqProjectPath(workDir: string): string {
  // 将所有非字母数字字符替换为连字符
  // Windows: E:\repo\demo → E--repo-demo
  // Unix:    /home/repo/demo → -home-repo-demo
}
```

结果：`~/.actoviq/projects/<encoded-path>/sessions/`

### 配置消费者

每个模块接收一个 `ResolvedRuntimeConfig` 对象——从不直接读取环境变量或文件。

### 硬编码默认值

```typescript
// 压缩配置：
autoCompactThresholdTokens: 155_000,
preserveRecentMessages: 8,
contextWindowTokens: 200_000,

// 运行时默认值：
provider = 'anthropic', maxTokens = 32000,
timeoutMs = 600000, maxToolIterations = Infinity
```

### 边界情况

1. **首次运行缺少 settings.json**：`loadDefaultActoviqSettings()` 返回空配置（不报错）
2. **显式配置路径但文件损坏**：`loadJsonConfigFile()` 抛出异常，CLI 以退出码 2 退出
3. **分级模型未配置环境变量**：`resolveActoviqModelReference()` 抛出 `ConfigurationError`
