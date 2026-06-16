# 02 — Config Pipeline

## Architecture

The config pipeline resolves all runtime settings from a strict priority chain.
No auto-detection — every value has a known source.

### Resolution Chain

```
1. CreateAgentSdkOptions     (programmatic, highest priority)
2. process.env               (ACTOVIQ_* variables)
3. ~/.actoviq/settings.json  (→ env block)
4. Hard defaults             (lowest priority)
```

Location: `src/config/resolveRuntimeConfig.ts:61`

### Why This Design

- **Predictable**: the same inputs always produce the same config
- **Debuggable**: every value traces back to exactly one source
- **Testable**: pass mock options, skip env/files entirely
- **No magic**: provider and baseURL require explicit configuration

## Module Design

### Files

| File | Role |
|---|---|
| `resolveRuntimeConfig.ts` | Main resolution function |
| `loadJsonConfigFile.ts` | Load + validate arbitrary JSON config |
| `loadDefaultActoviqSettings.ts` | Load `~/.actoviq/settings.json` |
| `modelTiers.ts` | `min`/`medium`/`max` alias resolution |
| `projectSessionDirectory.ts` | Workspace → session directory mapping |
| `anthropicEnvMapping.ts` | Actoviq env → Anthropic SDK env mapping |

### Model Tier Resolution

`src/config/modelTiers.ts`

Users can use tier aliases (`min`, `medium`, `max`) instead of concrete model
IDs. Resolution:

```typescript
const ACTOVIQ_MODEL_TIERS = ['min', 'medium', 'max'] as const;

function resolveActoviqModelReference(
  model: string,
  tiers: ActoviqModelTierConfig,
): string {
  if (isActoviqModelTier(model)) {
    const resolved = tiers[model];
    if (!resolved) throw new ConfigurationError(`No model configured for tier "${model}"`);
    return resolved;
  }
  return model;
}
```

Tier mappings come from:
- `ACTOVIQ_DEFAULT_MIN_MODEL` env var
- `ACTOVIQ_DEFAULT_MEDIUM_MODEL` env var
- `ACTOVIQ_DEFAULT_MAX_MODEL` env var

### Session Directory

`src/config/projectSessionDirectory.ts`

Sessions are scoped to workspace via path encoding:

```typescript
function encodeActoviqProjectPath(workDir: string): string {
  // Replace all non-alphanumeric chars with hyphens
  // Windows: E:\repo\demo → E--repo-demo
  // Unix:    /home/repo/demo → -home-repo-demo
}
```

Result: `~/.actoviq/projects/<encoded-path>/sessions/`

### Config Consumers

Every module receives a `ResolvedRuntimeConfig` object — never reads env vars
or files directly. The config object is passed through the call chain:

```
resolveRuntimeConfig()
    → ActoviqAgentClient constructor
        → executeConversation(options.config)
            → Tool execution context
            → ModelApi requests
```

## Code Details

### `resolveRuntimeConfig()` Core Logic

```typescript
export async function resolveRuntimeConfig(
  options: CreateAgentSdkOptions = {},
): Promise<ResolvedRuntimeConfig> {
  const homeDir = options.homeDir ?? os.homedir();
  const workDir = path.resolve(options.workDir ?? process.cwd());
  const loadedConfig = getLoadedJsonConfig();
  const envFromLoadedConfig = loadedConfig?.env ?? {};
  const envSources = [envFromLoadedConfig, process.env];

  // Auth: apiKey > authToken > error
  const apiKey = options.apiKey ??
    getRuntimeConfigValue('ACTOVIQ_API_KEY', ...envSources);
  const authToken = options.authToken ??
    getRuntimeConfigValue('ACTOVIQ_AUTH_TOKEN', ...envSources);

  // Provider resolution
  const provider = options.provider ??
    (getRuntimeConfigValue('ACTOVIQ_PROVIDER', ...envSources) as any) ??
    'anthropic';

  // Model resolution (with tier support)
  const model = resolveModel(options, provider, envSources, tiers);

  // Build ResolvedRuntimeConfig
  return {
    homeDir, workDir, provider, model, authToken, apiKey,
    baseURL, maxTokens, timeoutMs, maxToolIterations,
    effort, modelTier, modelTiers, compact, sessionDirectory,
    // ... 30+ fields
  };
}
```

### `loadJsonConfigFile()`

Location: `src/config/loadJsonConfigFile.ts`

```typescript
export async function loadJsonConfigFile(
  filePath: string,
): Promise<ActoviqJsonSettings & { exists: boolean; path: string }> {
  // Read file → JSON.parse → validate shape
  // Stores result in module-level singleton
  // Subsequent resolveRuntimeConfig() calls pick it up via getLoadedJsonConfig()
}
```

The loaded config is stored in a module-level variable. `clearLoadedJsonConfig()`
resets it — used in tests between cases.

### Hard Defaults

```typescript
const DEFAULT_COMPACT_CONFIG = {
  enabled: true,
  autoCompactThresholdTokens: 155_000,
  preserveRecentMessages: 8,
  maxSummaryTokens: 20_000,
  microcompactEnabled: true,
  microcompactKeepRecentToolResults: 3,
  microcompactMinContentChars: 1_000,
  apiMicrocompactEnabled: true,
  apiMicrocompactMaxInputTokens: 180_000,
  apiMicrocompactTargetInputTokens: 40_000,
  apiMicrocompactMaxRequestBytes: 1_500_000,
  toolResultArtifactMaxChars: 80_000,
  toolResultsPerMessageMaxChars: 200_000,
  loopAutoCompactEnabled: true,
  contextWindowTokens: 200_000,
};

// Runtime defaults:
//   provider = 'anthropic'
//   maxTokens = 32000
//   timeoutMs = 600000
//   maxToolIterations = Infinity
//   effort = undefined (auto)
```

### Provider Fallback

- Anthropic protocol with no model configured → throws `ConfigurationError`
- OpenAI protocol with no model configured → defaults to `gpt-4o`
- DeepSeek provider → sets `ACTOVIQ_IS_DEEPSEEK` flag for tool stripping

### Edge Cases

1. **Missing settings.json on first run**: `loadDefaultActoviqSettings()` returns
   an empty config (no error). The CLI warns only for non-ENOENT failures.
2. **Explicit config path with bad file**: `loadJsonConfigFile()` throws.
   `actoviq-react.ts` exits with code 2 — refuses to silently fall back.
3. **Model tier without env var**: `resolveActoviqModelReference()` throws
   `ConfigurationError`.
