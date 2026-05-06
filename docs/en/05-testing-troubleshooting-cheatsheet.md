# 05. Testing, Troubleshooting, and Cheat Sheet

This chapter is the short maintenance guide for daily development.

## 1. Core validation commands

Run these before you publish or open a pull request:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Optional local checks:

```bash
npm run smoke
npm run example:quickstart
```

## 2. Common problems

### Missing credentials

If you see a configuration error, check:

1. `~/.actoviq/settings.json`
2. `loadJsonConfigFile(...)`
3. required keys such as `ACTOVIQ_AUTH_TOKEN` and `ACTOVIQ_BASE_URL`

### Session not found

Check the session ID and the configured `sessionDirectory`.

### Tool not available

Check whether:

1. you passed the tool into `createAgentSdk(...)`
2. you attached the expected MCP server

### Skill not available

Check whether:

1. the skill is bundled, custom, or disk-loaded
2. the skill directory is one of the configured search paths

## 3. Handy example commands

```bash
npm run example:quickstart
npm run example:session
npm run example:stream-loop
npm run example:actoviq-skills
npm run example:actoviq-file-tools
npm run example:actoviq-memory
npm run example:actoviq-swarm
```

## 4. API cheat sheet

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

You now have the full tutorial set. If you want a single next step, run:

```bash
npm run example:quickstart
```
