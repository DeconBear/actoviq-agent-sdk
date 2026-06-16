# 22 — Tavily Search 与网络搜索

v0.5.0 新增的 AI 优化搜索后端。位置：`src/tools/tavilySearch.ts`

## 架构

纯 TypeScript 实现，零 Python 依赖。通过 Tavily REST API 直接 `fetch()` 调用。

```
TavilySearch 工具
    │
    ├── Key 解析：
    │   ├── TAVILY_API_KEY 环境变量
    │   └── ~/.tavily/config.json (自动检测)
    │
    ├── API 调用: POST https://api.tavily.com/search
    │   参数: query, depth, topic, max_results, include_answer, include_domains...
    │
    └── 结果格式化：
         ├── AI Answer (摘要)
         ├── 结构化 Results (title, url, content, score)
         └── Images (可选)
```

## 特性

| 参数 | 说明 |
|---|---|
| `depth: "basic"` | 快速搜索 (1-2s) |
| `depth: "advanced"` | 全面研究 (5-10s) |
| `topic: "general"` | 全网搜索 |
| `topic: "news"` | 最近 7 天新闻 |
| `max_results` | 1-20 条结果 |
| `include_answer` | AI 生成的答案摘要 |
| `include_domains` | 限定域名 |
| `exclude_domains` | 排除域名 |

## WebSearch 优先级链

```
WebSearch 执行顺序:
  1. Provider web_search (Anthropic/MiniMax 原生工具)
  2. 🆕 TavilySearch (TAVILY_API_KEY 存在时)
  3. DuckDuckGo JSON API
  4. DuckDuckGo HTML
```

`createActoviqCoreTools()` 在检测到 Tavily key 时自动加载。

## /tavily 技能

注册为 bundled skill，引导 Agent 正确使用 Tavily：

```
1. 从 depth="basic" 开始（大多数查询够用）
2. 仅复杂/细微主题使用 depth="advanced"
3. topic="news" 仅用于当前事件
4. 过滤已知可信源的域名
5. 在回答中始终使用 markdown 超链接引用来源
```

## 与 Claude Code Tavily Skills 的关系

Claude Code 的 Tavily skills（tavily-search, tavily-extract 等）使用 Python 脚本 + `tavily-python` 库。SDK 版本用 TypeScript 原生实现，零外部依赖。
