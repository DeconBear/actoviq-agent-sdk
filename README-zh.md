# Actoviq Agent SDK

[![CI](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/ci.yml)
[![Publish npm Package](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml/badge.svg)](https://github.com/DeconBear/actoviq-agent-sdk/actions/workflows/publish-npm.yml)
[![npm version](https://img.shields.io/npm/v/actoviq-agent-sdk)](https://www.npmjs.com/package/actoviq-agent-sdk)

[English](./README.md) | [涓枃](./README-zh.md)

Actoviq Agent SDK 鏄竴涓嫭绔嬬殑瀹為獙鎬?agent SDK 椤圭洰锛岃仛鐒﹀宸ュ叿銆佸浼氳瘽浠ュ強 bridge 杈呭姪鐨?agent 宸ヤ綔娴併€?

褰撳墠浠撳簱浠嶅浜庢祴璇曢瑙堢増闃舵锛屽苟涓旇繕鍦ㄦ寔缁紑鍙戜腑銆侫PI銆佽繍琛屾椂琛屼负銆佸懡鍚嶃€佹墦鍖呮柟寮忎互鍙?parity 瑕嗙洊鑼冨洿鍚庣画閮藉彲鑳界户缁皟鏁淬€傛杩庡ぇ瀹舵彁浜?Issue 鍜?PR銆?

鏈」鐩綋鍓嶄互鍏紑棰勮褰㈠紡鎸佺画杩唬寮€鍙戯紝鎺ュ彛鍜岃繍琛屾椂鑳藉姏浠嶄細缁х画瀹屽杽銆?

鏈」鐩噰鐢?[MIT License](./LICENSE) 寮€婧愬崗璁€?

## 椤圭洰浜偣

- 鎻愪緵 Node.js / TypeScript agent SDK锛屽寘鍚?`run()`銆乣stream()`銆乻ession銆乼ools 鍜?MCP 鏀寔
- 鎻愪緵 Actoviq Runtime bridge锛屽彲澶嶇敤 built-in tools銆乻kills銆乻ubagents 鍜屽師鐢?session/context 琛屼负
- 鎻愪緵涓庝笂娓?session-memory / compact 杈圭晫璇箟瀵归綈鐨?memory 涓?compact state helper
- 鎻愪緵 buddy / companion API锛屽彲鐢ㄤ簬瀛靛寲銆侀潤闊炽€佹姎鎽革紝浠ュ強鐢熸垚 companion prompt context
- 鍦?vendored 闈?TUI runtime 涔嬩笂鎻愪緵鏇村共鍑€鐨勫澶?SDK 琛ㄩ潰
- 鎻愪緵浜や簰寮忔祦寮忕ず渚嬶紝渚夸簬鏈湴璋冭瘯 agent
- 鎸佺画琛ラ綈 workspace 绠＄悊銆佹洿娣卞眰 subagent API锛屼互鍙婄鏈変緷璧栨浛浠?

## 蹇€熷紑濮?

### 1. 瀹夎渚濊禆

```bash
npm install
```

### 2. 鍑嗗 `~/.actoviq/settings.json`

鏈湴绀轰緥榛樿璇诲彇杩欎釜鏂囦欢锛?

```text
~/.actoviq/settings.json
```

濡傛灉鐩綍杩樹笉瀛樺湪锛屽彲浠ュ厛鍒涘缓锛?

```powershell
New-Item -ItemType Directory -Force $HOME\.actoviq | Out-Null
```

### 3. 杩愯鍩虹绀轰緥

```bash
npm run example:quickstart
```

### 4. 鍚姩浜や簰寮?agent 绀轰緥

```bash
npm run example:actoviq-interactive-agent
```

瀹冧細鍚姩涓€涓甫娴佸紡杈撳嚭銆佸伐鍏疯皟鐢ㄨ兘鍔涘拰鏃犻檺寰幆浼氳瘽鐨勪氦浜掑紡 REPL锛岀洿鍒颁綘涓诲姩閫€鍑恒€?

### 5. 鏌ョ湅 memory / compact state 绀轰緥

```bash
npm run example:actoviq-memory
npm run example:actoviq-session-memory
```

## 涓€鐪肩湅鎳傝繖涓粨搴?

杩欎釜浠撳簱鐜板湪涓昏鎻愪緵涓ゆ潯浣跨敤璺緞锛?

1. 鐢ㄤ簬涓氬姟闆嗘垚鐨勫共鍑€ SDK 灞?
2. 鐢ㄤ簬澶嶇敤 Actoviq 鍘熺敓闈?TUI agent 琛屼负鐨?runtime bridge 灞?

褰撳墠宸茬粡鍙敤鐨勮兘鍔涘寘鎷細

- 鍩轰簬 Zod 鐨勬湰鍦板伐鍏峰畾涔?
- 鏈湴銆乻tdio銆乻treamable HTTP 涓夌被 MCP 鎺ュ叆
- 鎸佷箙鍖?session
- bridge runtime introspection
- memory 璁剧疆銆乻ession-memory prompt銆乧ompact state 妫€鏌?helper
- vendored runtime 鏂囦欢宸ュ叿锛歚Read`銆乣Write`銆乣Edit`銆乣Glob`銆乣Grep`
- bridge runtime 鐨?built-in tools銆乻kills 鍜?subagents

## 浣滀负搴撳畨瑁?

```bash
npm install actoviq-agent-sdk zod
```

## 鍩虹 SDK 绀轰緥

```ts
import { z } from 'zod';
import { createAgentSdk, loadDefaultActoviqSettings, tool } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const addNumbers = tool(
  {
    name: 'add_numbers',
    description: 'Add two numbers together.',
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({ sum: a + b }),
);

const result = await sdk.run('Please use the add_numbers tool to calculate 19 + 23.', {
  tools: [addNumbers],
  systemPrompt: 'Use the provided tools whenever they are relevant.',
});

console.log(result.text);
await sdk.close();
```

## 鏍稿績绀轰緥

### 澶氳疆浼氳瘽绀轰緥

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();
const session = await sdk.createSession({ title: 'Demo Session' });

await session.send('Remember that my project codename is Sparrow.');
const reply = await session.send('What is my project codename?');

console.log(reply.text);
```

### 寰幆娴佸紡绀轰緥

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const prompts = [
  'Introduce yourself in one concise sentence.',
  'Now summarize the key idea of your previous sentence in one sentence.',
  'Finally, give two short suggestions that would help a developer call this SDK more reliably.',
];

const session = await sdk.createSession({ title: 'Stream Loop Example' });

for (const prompt of prompts) {
  const stream = session.stream(prompt);

  for await (const event of stream) {
    if (event.type === 'response.text.delta') {
      process.stdout.write(event.delta);
    }
  }

  const result = await stream.result;
  console.log('\nfinal:', result.text);
}

await sdk.close();
```

### Session Memory 示例

```ts
import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

const session = await sdk.createSession({ title: 'Session Memory Demo' });
await session.send('We should bump package.json before tagging the next release.');
await session.send('We also want CI green and concise release notes before publish.');

const extraction = await session.extractMemory();
const compactState = await session.compactState({
  includeSessionMemory: true,
  includeSummaryMessage: true,
});

console.log(extraction);
console.log(compactState.runtimeState);
console.log(compactState.sessionMemory?.content);
```
### Buddy 绀轰緥

```ts
import { createActoviqBuddyApi } from 'actoviq-agent-sdk';

const buddy = createActoviqBuddyApi({
  configPath: './buddy-settings.json',
  userId: 'demo-user',
});

const companion = await buddy.hatch({
  name: 'Orbit',
  personality: 'curious, calm, and observant',
});

console.log(companion);
console.log(await buddy.pet());
console.log(await buddy.getPromptContext());
```

浠撳簱鍐呭彲鐩存帴杩愯锛?

```bash
npm run example:actoviq-buddy
```

## 浜や簰寮?Agent 绀轰緥

浠撳簱涓寘鍚竴涓熀浜?bridge 鐨勪氦浜掑紡绀轰緥锛屽叿澶囷細

- 娴佸紡鍥炵瓟
- 鍐呯疆宸ュ叿璁块棶鑳藉姏
- vendored runtime 鎻愪緵鐨?skills 鍜?subagents
- 鍙湪浠ｇ爜涓洿鎺ヨ缃伐浣滅┖闂磋矾寰?
- 鍙湪浠ｇ爜涓洿鎺ヨ缃?JSON 閰嶇疆璺緞
- 鏃犻檺寰幆锛岀洿鍒扮敤鎴蜂富鍔ㄩ€€鍑?

鍚姩鍛戒护锛?

```bash
npm run example:actoviq-interactive-agent
```

涓昏鍙皟椤逛綅浜庯細
[`examples/actoviq-interactive-agent.ts`](./examples/actoviq-interactive-agent.ts)

```ts
const WORKSPACE_PATH = process.cwd();
const JSON_CONFIG_PATH = path.resolve(
  process.cwd(),
  'examples',
  'interactive-agent.settings.local.json',
);
```

浠撳簱涓寘鍚細

- [`examples/interactive-agent.settings.example.json`](./examples/interactive-agent.settings.example.json)锛氬畨鍏ㄦā鏉?
- `examples/interactive-agent.settings.local.json`锛氫粎渚涙湰鏈鸿皟璇曚娇鐢ㄧ殑鏈湴閰嶇疆鏂囦欢

鍏朵腑鏈湴璋冭瘯鏂囦欢宸茶 git 蹇界暐銆?

## Runtime Bridge

浣犱篃鍙互鐩存帴閫氳繃鏈?SDK 璋冭捣 vendored 鐨勯潪 TUI Actoviq Runtime銆?
杩欏眰 bridge 澶嶇敤浜嗕笂娓?headless CLI锛屽洜姝や細甯︿笂鍐呯疆宸ュ叿姹犮€乻kills銆乻ubagents锛屼互鍙婂師鐢?session/context 琛屼负銆?

```ts
import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const sdk = await createActoviqBridgeSdk({
  workDir: process.cwd(),
  maxTurns: 4,
});

const result = await sdk.run(
  'Use Actoviq Runtime tools to inspect the examples directory, then summarize examples/quickstart.ts.',
);

console.log(result.initEvent?.agents);
console.log(result.initEvent?.skills);
console.log(result.sessionId);
console.log(result.text);
console.log(result.events.length);
```

Bridge 璇存槑锛?

- 瀹冮€氳繃 Bun 鎵ц vendored 鐨?Actoviq Runtime CLI bundle
- 浼氳嚜鍔ㄦ敞鍏ョ敱 `loadJsonConfigFile(...)` 鎴?`loadDefaultActoviqSettings()` 鍔犺浇鐨勭幆澧冨彉閲?
- 濡傛灉绯荤粺閲屽彲鐢?`rg`锛宐ridge 浼氫紭鍏堜娇鐢ㄧ郴缁?`rg`锛屼繚璇?`Glob` 鍜?`Grep` 鍦ㄧ己灏?bundled ripgrep 浜岃繘鍒舵椂渚濇棫鍙伐浣?

## Agent / Skill Helper

bridge SDK 鐜板湪琛ヤ笂浜嗘洿鐩存帴鐨勯珮灞?helper锛屼笉闇€瑕佷綘姣忔鎵嬪姩鎷?`agent` 鍙傛暟鎴?slash command銆?

```ts
import { createActoviqBridgeSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createActoviqBridgeSdk({ workDir: process.cwd() });

const reviewer = sdk.useAgent('general-purpose');
const reviewResult = await reviewer.run('Explain what this repository is for.');

const debugSkill = sdk.useSkill('debug');
const debugResult = await debugSkill.run(
  'briefly explain what kinds of debugging help this runtime can provide without printing secrets, tokens, or full config values',
);

const compactResult = await sdk.context.compact('summarize current progress');
const runtimeCatalog = await sdk.getRuntimeCatalog();
```

褰撳墠鍙互鐩存帴浣跨敤锛?

- `sdk.agents.list()`
- `sdk.agents.run(...)`
- `sdk.skills.list()`
- `sdk.skills.listMetadata()`
- `sdk.skills.run(...)`
- `sdk.tools.list()`
- `sdk.tools.listMetadata()`
- `sdk.slashCommands.list()`
- `sdk.slashCommands.listMetadata()`
- `sdk.getRuntimeCatalog()`
- `sdk.runWithAgent(...)`
- `sdk.runSkill(...)`
- `sdk.sessions.continueMostRecent(...)`
- `sdk.sessions.fork(...)`
- `session.runSkill(...)`
- `session.compact(...)`
- `session.info()`
- `session.messages()`
- `session.fork(...)`

## Memory / Compact Helper

SDK 鐜板湪涔熸彁渚涗簡鍙鐢ㄧ殑 memory / compact state helper锛岃璁′笂瀵归綈涓婃父
`claude-code` 鐨?session-memory 涓?compact boundary 璇箟銆傝繖鏍锋垜浠彲浠ョ洿鎺ユ鏌?`.actoviq` 涓嬬殑 memory 璺緞銆乻ession-memory 妯℃澘涓?prompt銆乧ompact 杈圭晫鍘嗗彶锛?浠ュ強褰撳墠鏄惁婊¤冻 session-memory 鎻愬彇鎴?compaction 鐨勯槇鍊兼潯浠讹紝鍚屾椂涔熻ˉ涓?relevant memory 鐨?scan / select / surface helper銆?
鍦ㄦ爣鍑?SDK 璺緞涓嬶紝褰?auto memory 鎵撳紑鏃讹紝SDK 鐜板湪涔熶細鍦ㄦ瘡涓敤鎴?turn 寮€濮嬫椂
鑷姩鎶?relevant memories 浣滀负 meta reminder 娉ㄥ叆锛屽苟鍦?session 鍐呭宸茬粡 surfacing
杩囩殑 memory 鍋氬幓閲嶅拰瀛楄妭棰勭畻鎺у埗銆?
Session-based 标准 SDK 现在也补上了更完整的 session-memory 自动提取链路：

- 对话达到阈值后会自动初始化 session memory
- 提取判断会综合 token 增长、tool call 活动以及自然 turn break
- 满足条件的 session turn 结束后会自动刷新 summary.md
- 也可以通过 `session.extractMemory()` 手动强制刷新
- `session.compactState()` 会把文件系统 compact state 和 runtime 提取状态一起返回

```ts
import {
  createActoviqMemoryApi,
  loadDefaultActoviqSettings,
} from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();

const memory = createActoviqMemoryApi({
  projectPath: process.cwd(),
  sessionId: 'your-session-id',
});

const state = await memory.compactState({
  includeSessionMemory: true,
  includeBoundaries: true,
  includeSummaryMessage: true,
  currentTokenCount: 18000,
  tokensAtLastExtraction: 11000,
  initialized: true,
  toolCallsSinceLastUpdate: 4,
});

console.log(state.paths);
console.log(state.progress);
console.log(state.latestBoundary);
console.log(state.summaryMessage);
console.log(await memory.findRelevantMemories('how should I release this package?'));
console.log(await memory.surfaceRelevantMemories('how should I release this package?'));
```

褰撳墠鍙洿鎺ヤ娇鐢細

- `createActoviqMemoryApi(...)`
- `sdk.memory`
- `bridgeSdk.memory`
- `memory.paths()`
- `memory.getSettings()`
- `memory.updateSettings(...)`
- `memory.loadSessionTemplate()`
- `memory.loadSessionPrompt()`
- `memory.buildPromptWithEntrypoints()`
- `memory.buildSessionUpdatePrompt(...)`
- `memory.readSessionMemory(...)`
- `memory.scanMemoryFiles(...)`
- `memory.formatMemoryManifest(...)`
- `memory.findRelevantMemories(...)`
- `memory.surfaceRelevantMemories(...)`
- `memory.getSessionMemoryConfig()`
- `memory.getSessionMemoryCompactConfig()`
- `memory.evaluateSessionMemoryProgress(...)`
- `session.extractMemory(...)`
- `parseActoviqSessionMemoryRuntimeState(...)`
- `filterActoviqMessagesForSessionMemory(...)`
- `estimateActoviqConversationTokens(...)`
- `evaluateActoviqSessionMemoryProgress(...)`
- `memory.compactState(...)`
- `memory.buildSessionMemoryCompactSummary(...)`
- `getActoviqBridgeCompactBoundaries(...)`
- `getActoviqBridgeLatestCompactBoundary(...)`
- `session.compactState(...)`
- `sdk.context.compactState(...)`
- `sdk.sessions.getCompactState(...)`

浠撳簱鍐呯ず渚嬪懡浠わ細

```bash
npm run example:actoviq-memory
npm run example:actoviq-session-memory
```

## Buddy Helper

SDK 鐜板湪涔熸妸闈?TUI 鐨?buddy / companion 鑳藉姏灏佽鎴愪簡鍙鐢?API銆?

```ts
import { createActoviqBuddyApi } from 'actoviq-agent-sdk';

const buddy = createActoviqBuddyApi({ configPath: './settings.json' });
const state = await buddy.state();

if (!state.buddy) {
  await buddy.hatch({
    name: 'Orbit',
    personality: 'curious, steady, and supportive',
  });
}

console.log(await buddy.getPromptContext());
```

褰撳墠鍙洿鎺ヤ娇鐢細

- `createActoviqBuddyApi(...)`
- `sdk.buddy`
- `bridgeSdk.buddy`
- `buddy.state()`
- `buddy.get()`
- `buddy.hatch(...)`
- `buddy.mute()`
- `buddy.unmute()`
- `buddy.pet()`
- `buddy.getPromptContext(...)`
- `buddy.getIntroAttachment(...)`
- `buddy.getIntroText(...)`

鍦ㄦ爣鍑?SDK 璺緞涓嬶紝濡傛灉 buddy 宸插鍖栦笖鏈潤闊筹紝companion intro text 涔熶細鑷姩闄勫姞鍒?system prompt 涓€?

## Event Helper

bridge 鐜板湪涔熸彁渚涗簡鍙鐢ㄧ殑浜嬩欢瑙ｆ瀽 helper锛屾柟渚跨粺涓€澶勭悊 `Task` / subagent / tool 鐩稿叧浜嬩欢銆?

```ts
import {
  analyzeActoviqBridgeEvents,
  getActoviqBridgeTextDelta,
} from 'actoviq-agent-sdk';

const stream = sdk.stream('inspect the current repository');
const bufferedEvents = [];

for await (const event of stream) {
  bufferedEvents.push(event);

  const delta = getActoviqBridgeTextDelta(event);
  if (delta) {
    process.stdout.write(delta);
  }
}

const analysis = analyzeActoviqBridgeEvents(bufferedEvents);
console.log(analysis.toolRequests);
console.log(analysis.taskInvocations);
console.log(analysis.toolResults);
```

- `getActoviqBridgeTextDelta(...)`
- `extractActoviqBridgeToolRequests(...)`
- `extractActoviqBridgeToolResults(...)`
- `extractActoviqBridgeTaskInvocations(...)`
- `analyzeActoviqBridgeEvents(...)`

## Workspace Helper

鐜板湪 SDK 涔熻ˉ涓婁簡鏄惧紡鐨?workspace 鐢熷懡鍛ㄦ湡 helper锛屼究浜庡厛鍒涘缓闅旂鐩綍锛屽啀鍚姩 agent 浼氳瘽銆?

```ts
import {
  createAgentSdk,
  createTempWorkspace,
  createActoviqFileTools,
} from 'actoviq-agent-sdk';

const workspace = await createTempWorkspace({
  prefix: 'actoviq-demo-',
  copyFrom: './examples',
});

const sdk = await createAgentSdk({
  workDir: workspace.path,
  tools: createActoviqFileTools({ cwd: workspace.path }),
});

await sdk.close();
await workspace.dispose();
```

褰撳墠鎻愪緵锛?

- `createWorkspace(...)`
- `createTempWorkspace(...)`
- `createGitWorktreeWorkspace(...)`


## 褰撳墠鐘舵€佷笌璺嚎鍥?

褰撳墠鐘舵€侊細

- npm 鍖呭凡缁忓彂甯冿紝鍙洿鎺ュ畨瑁呬娇鐢?
- 鏍稿績 SDK 涓婚摼宸插彲鐢細`run()`銆乣stream()`銆乻ession銆乼ools銆丮CP
- bridge runtime 涓婚摼宸插彲鐢細鍐呯疆宸ュ叿銆乺untime introspection銆佷氦浜掑紡绀轰緥
- bridge SDK 宸茶ˉ鏇撮珮灞傜殑 agent / skill / context helper
- bridge SDK 宸茶ˉ缁撴瀯鍖?metadata API 鍜?event helper
- buddy API 宸插湪鏍囧噯 SDK 鍜?bridge SDK 涓や晶鍙敤
- 鏂囦欢宸ュ叿宸茬粡鍙敤锛歚Read`銆乣Write`銆乣Edit`銆乣Glob`銆乣Grep`
- workspace 鐢熷懡鍛ㄦ湡 helper 宸插彲鐢細鐩綍銆佷复鏃跺伐浣滃尯銆乬it worktree
- examples銆乼ests銆乥uild銆乻moke 鍜屾墦鍖呮牎楠岄兘宸茬粡鍏峰

璺嚎鍥撅細

- 缁х画琛?context銆乵emory銆乧ompact 绛夋洿娣卞眰鎺у埗鑳藉姏
- 缁х画琛ユ洿涓板瘜鐨?agent / skill / subagent metadata 缁嗚妭
- 缁х画琛ユ洿瀹屾暣鐨?workspace 妯℃澘鍜?sandbox orchestration
- 琛?CI銆乺elease notes锛屼互鍙婃洿瀹屾暣鐨勮础鐚枃妗?

## 鏈湴寮€鍙戝懡浠?

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run example:quickstart
npm run example:session
npm run example:stream-loop
npm run example:actoviq-bridge-sdk
npm run example:actoviq-interactive-agent
npm run example:actoviq-introspection
npm run example:actoviq-file-tools
npm run example:actoviq-agent-helpers
npm run example:actoviq-workspaces
npm run example:actoviq-sessions
npm run example:actoviq-session-messages
npm run example:actoviq-buddy
```

`npm run smoke` 浼氳鍙?`~/.actoviq/settings.json` 骞舵墽琛屼竴娆＄湡瀹炶仈璋冮獙璇併€?

## 鍙備笌璐＄尞

褰撳墠椤圭洰浠嶅湪蹇€熻凯浠ｄ腑銆傚鏋滀綘鍙戠幇闂銆佺湅鍒扮己澶辩殑 parity 鑳藉姏锛屾垨鑰呮兂鎻愬嚭鏇村ソ鐨?API 璁捐锛屾杩庣洿鎺ユ彁 Issue 鎴栧彂 PR銆?


