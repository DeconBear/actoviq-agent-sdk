/**
 * Tavily Search Tool — AI-optimized web search via Tavily REST API.
 * No Python dependency. Uses fetch() directly.
 *
 * Requires: TAVILY_API_KEY env var (get key at https://tavily.com)
 */
import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type { ToolCallProgress, ToolExecutionContext } from '../types.js';

export const TAVILY_SEARCH_TOOL_NAME = 'TavilySearch';

const tavilySearchSchema = z.strictObject({
  query: z.string().min(2).describe('The search query'),
  depth: z.enum(['basic', 'advanced']).optional().default('basic')
    .describe('Search depth: basic (fast, 1-2s) or advanced (comprehensive, 5-10s)'),
  topic: z.enum(['general', 'news']).optional().default('general')
    .describe('general for broad web, news for current events (last 7 days)'),
  max_results: z.number().int().min(1).max(20).optional().default(5)
    .describe('Number of results (1-20)'),
  include_answer: z.boolean().optional().default(true)
    .describe('Include AI-generated answer summary'),
  include_raw_content: z.boolean().optional().default(false)
    .describe('Include raw HTML content of sources'),
  include_domains: z.array(z.string()).optional()
    .describe('Only include results from these domains'),
  exclude_domains: z.array(z.string()).optional()
    .describe('Exclude results from these domains'),
});

type TavilySearchInput = z.infer<typeof tavilySearchSchema>;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  images?: string[];
  response_time?: number;
}

function formatResults(data: TavilyResponse, input: TavilySearchInput): string {
  const lines: string[] = [];

  lines.push(`Query: "${data.query}"`);
  if (data.response_time) lines.push(`Response time: ${data.response_time.toFixed(2)}s`);

  if (data.answer) {
    lines.push('');
    lines.push('## AI Answer');
    lines.push(data.answer);
  }

  if (data.results.length > 0) {
    lines.push('');
    lines.push(`## Results (${data.results.length})`);
    for (let i = 0; i < data.results.length; i++) {
      const r = data.results[i]!;
      lines.push(`\n${i + 1}. **${r.title}**`);
      lines.push(`   URL: ${r.url}`);
      lines.push(`   Score: ${r.score.toFixed(2)}`);
      lines.push(`   ${r.content.slice(0, 300)}`);
    }
  }

  if (data.images && data.images.length > 0) {
    lines.push(`\n## Images (${data.images.length})`);
    for (const img of data.images.slice(0, 5)) {
      lines.push(`   ${img}`);
    }
  }

  return lines.join('\n');
}

export function createTavilySearchTool() {
  return tool(
    {
      name: TAVILY_SEARCH_TOOL_NAME,
      description:
        'AI-optimized web search via Tavily. Returns clean structured results with ' +
        'optional AI-generated answer summary. Supports domain filtering, news search, ' +
        'and raw content extraction. Use for research, fact-checking, current events.',
      inputSchema: tavilySearchSchema,
      isReadOnly: () => true,
      prompt: async () => [
        '## TavilySearch Tool',
        'AI-optimized web search. Key capabilities:',
        '- AI-generated answer summaries from search results',
        '- Clean structured results (title, URL, content, relevance score)',
        '- `depth: "basic"` for quick facts, `"advanced"` for comprehensive research',
        '- `topic: "news"` for current events (last 7 days)',
        '- Domain filtering with `include_domains` / `exclude_domains`',
        '- Set `include_raw_content: true` for full HTML of sources',
        '',
        'Best practices:',
        '- Start with basic depth for most queries',
        '- Use advanced only for complex research topics',
        '- Limit max_results to what you actually need',
        '- Always cite sources in your response',
      ].join('\n'),
    },
    async (input: TavilySearchInput, _context: ToolExecutionContext, onProgress?: ToolCallProgress) => {
      // Resolve API key: env var > ~/.tavily/config.json
      let apiKey = process.env.TAVILY_API_KEY;
      if (!apiKey) {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const os = await import('node:os');
          const configPath = path.join(os.homedir(), '.tavily', 'config.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            apiKey = config.api_key;
          }
        } catch { /* ignore */ }
      }
      if (!apiKey) {
        return 'Error: Tavily API key not found. Set TAVILY_API_KEY env var or create ~/.tavily/config.json with {"api_key": "tvly-..."}. Get a free key at https://tavily.com';
      }

      onProgress?.({
        toolUseID: '',
        data: { type: 'searching', message: `Tavily search: "${input.query}" (${input.depth}/${input.topic})` },
      });

      const body: Record<string, unknown> = {
        api_key: apiKey,
        query: input.query,
        search_depth: input.depth,
        topic: input.topic,
        max_results: input.max_results,
        include_answer: input.include_answer,
        include_raw_content: input.include_raw_content,
      };
      if (input.include_domains) body.include_domains = input.include_domains;
      if (input.exclude_domains) body.exclude_domains = input.exclude_domains;

      try {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          return `Tavily search failed: HTTP ${response.status} ${response.statusText}. ${errText.slice(0, 200)}`;
        }

        const data = (await response.json()) as TavilyResponse;
        return formatResults(data, input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('abort') || message.includes('timeout')) {
          return `Tavily search timed out after 30s. Try a simpler query or use basic depth.`;
        }
        return `Tavily search failed: ${message}`;
      }
    },
  );
}
