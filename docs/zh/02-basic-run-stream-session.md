# 02. 基础调用：run、stream、session

这一章讲最常用的三种调用方式：

1. 单次调用 `run(...)`
2. 流式调用 `stream(...)`
3. 多轮对话 `session`

## 1. `createAgentSdk()`

clean SDK 的入口是：

```ts
import { createAgentSdk } from 'actoviq-agent-sdk';

const sdk = await createAgentSdk();
```

常见可传选项包括：

1. `workDir`
2. `tools`
3. `mcpServers`
4. `agents`
5. `skills`
6. `permissionMode`
7. `permissions`

## 2. 单次调用 `run(...)`

当你只想完成一次任务，不需要保留上下文时，用 `run(...)`：

```ts
const result = await sdk.run('请用一段话说明这个 SDK 是做什么的。');
console.log(result.text);
console.log(result.toolCalls);
```

## 3. 流式调用 `stream(...)`

如果你想边生成边输出，用 `stream(...)`：

```ts
const stream = sdk.stream('请解释一下 session 是什么。');

for await (const event of stream) {
  if (event.type === 'response.text.delta') {
    process.stdout.write(event.delta);
  }
}

const result = await stream.result;
console.log('\nfinal:', result.text);
```

## 4. 多轮会话 `session`

如果你希望模型记住前面对话，就要创建 session：

```ts
const session = await sdk.createSession({ title: 'Demo Session' });

await session.send('记住发布代号是 Sparrow');
const reply = await session.send('发布代号是什么？');

console.log(session.id);
console.log(reply.text);
```

## 5. 每个 session 的 ID 在哪里看？

你可以从这几个地方看到：

1. `session.id`
2. `result.sessionId`
3. `sdk.sessions.list()`

示例：

```ts
const session = await sdk.createSession({ title: 'My Session' });
console.log(session.id);

const sessions = await sdk.sessions.list();
console.log(sessions);
```

## 6. 历史对话保存在哪里？

clean SDK 的 session 历史是本地文件存储。

默认目录：

```text
~/.actoviq/actoviq-agent-sdk
```

里面保存的内容通常包括：

1. session ID
2. 标题
3. tags
4. metadata
5. messages
6. run history
7. 时间戳

## 7. 这个保存位置可以修改吗？

可以。创建 SDK 时传 `sessionDirectory`：

```ts
const sdk = await createAgentSdk({
  sessionDirectory: 'E:/my-session-store',
});
```

这样 clean SDK 的 session 文件就会写到你指定的位置。

## 8. session ID 可以自定义吗？

当前不可以。

session ID 是 SDK 自动生成的。现在你可以自定义的是：

1. `title`
2. `tags`
3. `metadata`
4. `sessionDirectory`

## 9. 怎么查看历史 session 并恢复？

```ts
const sessions = await sdk.sessions.list();
console.log(sessions);

const restored = await sdk.resumeSession('your-session-id');
const reply = await restored.send('继续刚才的话题。');
console.log(reply.text);
```

## 10. 一个完整的 session 管理示例

```ts
const sdk = await createAgentSdk();

const session = await sdk.createSession({
  title: 'Release Planning',
  tags: ['release', 'ci'],
  metadata: { owner: 'team-a' },
});

await session.send('记住发布步骤里必须先运行 npm pack --dry-run。');

console.log('current id:', session.id);
console.log('stored sessions:', await sdk.sessions.list());

const restored = await sdk.resumeSession(session.id);
console.log((await restored.send('发布步骤里必须包含什么？')).text);
```

下一章：

- [03-tools-permissions-mcp.md](./03-tools-permissions-mcp.md)
