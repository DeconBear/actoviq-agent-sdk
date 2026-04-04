# 06. 测试、排错与速查

这一章是日常开发和发布时最实用的维护手册。

## 1. 核心验证命令

在发版或提交 PR 之前，建议至少执行：

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

本地联调时还可以运行：

```bash
npm run smoke
npm run example:quickstart
npm run example:actoviq-interactive-agent
```

## 2. 常见问题

### 没有找到凭据

优先检查：

1. `~/.actoviq/settings.json`
2. 你是否先调用了 `loadJsonConfigFile(...)`
3. `ACTOVIQ_AUTH_TOKEN`
4. `ACTOVIQ_BASE_URL`

### 找不到 session

检查：

1. `session.id` 是否正确
2. `sessionDirectory` 是否被改过
3. 你是不是在另一个目录或另一个 `homeDir` 下创建了 session

### 找不到工具

检查：

1. 你是否把工具传给了 `createAgentSdk(...)`
2. 你是否挂上了正确的 MCP server
3. 你是不是把 bridge/runtime 才有的能力误以为 clean SDK 默认自带

### 找不到 skill

检查：

1. 它是 bundled、custom，还是从磁盘加载的 skill
2. skill 目录是否在搜索路径中
3. 你现在运行的是 clean SDK 还是 bridge SDK

### dream 没有触发

检查：

1. 是否开启了 `autoDreamEnabled`
2. 是否已经累积了足够多的最近 session
3. 是否刚刚才做过一次 consolidation
4. lock 是否还在生效

### buddy 没有生效

检查：

1. 是否已经执行 `sdk.buddy.hatch(...)`
2. 是否被 `mute()` 掉了
3. 是否是在新的 SDK 实例里重新运行，导致状态还没初始化

## 3. 常用示例命令

```bash
npm run example:quickstart
npm run example:session
npm run example:stream-loop
npm run example:actoviq-skills
npm run example:actoviq-memory
npm run example:actoviq-dream
npm run example:actoviq-swarm
npm run example:actoviq-interactive-agent
```

## 4. API 速查

clean SDK：

1. `createAgentSdk(...)`
2. `sdk.run(...)`
3. `sdk.stream(...)`
4. `sdk.createSession(...)`
5. `sdk.skills.listMetadata()`
6. `sdk.runSkill(...)`
7. `session.runSkill(...)`
8. `session.extractMemory(...)`
9. `session.compactState(...)`
10. `sdk.dreamState()`
11. `session.dream(...)`
12. `sdk.buddy.hatch(...)`
13. `sdk.swarm.createTeam(...)`

bridge SDK：

1. `createActoviqBridgeSdk(...)`
2. `sdk.getRuntimeInfo()`
3. `sdk.listAgents()`
4. `sdk.listSkills()`
5. `sdk.runSkill(...)`
6. `sdk.runWithAgent(...)`
