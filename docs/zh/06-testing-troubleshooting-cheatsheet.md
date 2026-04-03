# 06. 测试、排错与速查

这一章是日常开发和发版时最实用的维护手册。

## 1. 核心验证命令

在发版或提 PR 之前，建议至少跑：

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

可选的本地检查：

```bash
npm run smoke
npm run example:quickstart
npm run example:actoviq-interactive-agent
```

## 2. 常见问题

### 缺少凭据

如果报配置错误，优先检查：

1. `~/.actoviq/settings.json`
2. `loadJsonConfigFile(...)`
3. `ACTOVIQ_AUTH_TOKEN`
4. `ACTOVIQ_BASE_URL`

### 找不到 session

检查：

1. session ID 是否正确
2. `sessionDirectory` 是否改过

### 找不到工具

检查：

1. 你是否把工具传进了 `createAgentSdk(...)`
2. 你是否挂上了对应的 MCP server
3. 你是不是在期待 bridge/runtime 才有的原生工具

### 找不到 skill

检查：

1. 它是 bundled、custom，还是从磁盘加载的 skill
2. skill 目录是否在搜索路径中
3. 你是不是在期待 bridge/runtime 才有的原生 skill

## 3. 常用示例命令

```bash
npm run example:quickstart
npm run example:session
npm run example:stream-loop
npm run example:actoviq-skills
npm run example:actoviq-file-tools
npm run example:actoviq-memory
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
10. `sdk.swarm.createTeam(...)`

bridge SDK：

1. `createActoviqBridgeSdk(...)`
2. `sdk.getRuntimeInfo()`
3. `sdk.skills.listMetadata()`
4. `sdk.runSkill(...)`
5. `sdk.runWithAgent(...)`
6. `sdk.sessions.continueMostRecent(...)`
7. `sdk.sessions.fork(...)`

如果你现在只想做一件事来确认环境正常，先运行：

```bash
npm run example:quickstart
```
