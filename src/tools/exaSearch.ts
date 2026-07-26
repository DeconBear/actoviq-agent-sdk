/**
 * Exa Search Tool — neural web search via Exa REST API (https://exa.ai/).
 * Pure TypeScript / fetch; no SDK dependency.
 *
 * Requires: EXA_API_KEY env var or managed plugin apiKey
 * (get a key at https://dashboard.exa.ai/api-keys).
 */
import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { ToolCallProgress, ToolExecutionContext } from '../types.js';

export const EXA_SEARCH_TOOL_NAME = 'ExaSearch';

const exaSearchSchema = z.strictObject({
  query: z.string().min(2).describe('Natural-language search query'),
  type: z.enum(['auto', 'fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning'])
    .optional()
    .default('auto')
    .describe('Search method. Prefer auto unless you need lower latency or deeper research.'),
  num_results: z.number().int().min(1).max(25).optional().default(5)
    .describe('Number of results to return (1-25)'),
  category: z.enum([
    'company',
    'research paper',
    'news',
    'pdf',
    'github',
    'tweet',
    'personal site',
    'linkedin profile',
    'financial report',
  ]).optional()
    .describe('Optional content category focus'),
  include_domains: z.array(z.string()).optional()
    .describe('Only include results from these domains'),
  exclude_domains: z.array(z.string()).optional()
    .describe('Exclude results from these domains'),
  include_text: z.boolean().optional().default(true)
    .describe('Include page text excerpts when available'),
  include_highlights: z.boolean().optional().default(true)
    .describe('Include query-relevant highlights'),
});

type ExaSearchInput = z.infer<typeof exaSearchSchema>;

interface ExaResult {
  title?: string;
  url?: string;
  id?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaResponse {
  requestId?: string;
  results?: ExaResult[];
  resolvedSearchType?: string;
}

export interface CreateExaSearchToolOptions {
  /** Prefer this key over env / config file resolution. */
  apiKey?: string;
  timeoutMs?: number;
}

function formatResults(data: ExaResponse, input: ExaSearchInput): string {
  const lines: string[] = [];
  lines.push(`Query: "${input.query}"`);
  if (data.resolvedSearchType) lines.push(`Search type: ${data.resolvedSearchType}`);
  if (data.requestId) lines.push(`Request id: ${data.requestId}`);

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    lines.push('', 'No results.');
    return lines.join('\n');
  }

  lines.push('', `## Results (${results.length})`);
  for (let i = 0; i < results.length; i++) {
    const item = results[i]!;
    lines.push(`\n${i + 1}. **${item.title || 'Untitled'}**`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.author) lines.push(`   Author: ${item.author}`);
    if (item.summary) lines.push(`   Summary: ${item.summary.slice(0, 400)}`);
    if (item.highlights?.length) {
      lines.push(`   Highlights: ${item.highlights.slice(0, 3).join(' | ').slice(0, 400)}`);
    } else if (item.text) {
      lines.push(`   ${item.text.slice(0, 400)}`);
    }
  }
  return lines.join('\n');
}

export async function resolveExaApiKey(explicit?: string): Promise<string | undefined> {
  const fromExplicit = explicit?.trim();
  if (fromExplicit) return fromExplicit;
  const fromEnv = process.env.EXA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const configPath = path.join(os.homedir(), '.exa', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { api_key?: string; apiKey?: string };
      const key = config.api_key?.trim() || config.apiKey?.trim();
      if (key) return key;
    }
  } catch {
    // ignore unreadable config
  }
  return undefined;
}

export async function runExaSearch(
  input: ExaSearchInput,
  options: CreateExaSearchToolOptions = {},
): Promise<string> {
  const apiKey = await resolveExaApiKey(options.apiKey);
  if (!apiKey) {
    return 'Error: Exa API key not found. Set EXA_API_KEY, save apiKey in the Exa managed plugin, or create ~/.exa/config.json with {"api_key":"..."}. Get a key at https://dashboard.exa.ai/api-keys';
  }

  const body: Record<string, unknown> = {
    query: input.query,
    type: input.type,
    numResults: input.num_results,
    contents: {
      ...(input.include_text ? { text: { maxCharacters: 2_000 } } : {}),
      ...(input.include_highlights ? { highlights: true } : {}),
    },
  };
  if (input.category) body.category = input.category;
  if (input.include_domains?.length) body.includeDomains = input.include_domains;
  if (input.exclude_domains?.length) body.excludeDomains = input.exclude_domains;

  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
  try {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return `Exa search failed: HTTP ${response.status} ${response.statusText}. ${errText.slice(0, 200)}`;
    }
    const data = (await response.json()) as ExaResponse;
    return formatResults(data, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort') || message.includes('timeout')) {
      return `Exa search timed out after ${Math.round(timeoutMs / 1000)}s. Try type "fast" or fewer results.`;
    }
    return `Exa search failed: ${message}`;
  }
}

export function createExaSearchTool(options: CreateExaSearchToolOptions = {}) {
  return tool(
    {
      name: EXA_SEARCH_TOOL_NAME,
      description:
        'Neural web search via Exa (exa.ai). Returns LLM-oriented results with optional '
        + 'highlights and text excerpts. Strong for research papers, companies, news, and '
        + 'semantically rich queries. Use for discovery and citation-backed research.',
      inputSchema: exaSearchSchema,
      isReadOnly: () => true,
      prompt: async () => [
        '## ExaSearch Tool',
        'Neural web search optimized for LLM consumption:',
        '- Prefer type "auto" unless latency or deep research needs dictate otherwise',
        '- Use category when the query clearly maps to papers, news, github, etc.',
        '- Keep num_results small; expand only when needed',
        '- Always cite source URLs in your response',
      ].join('\n'),
    },
    async (input: ExaSearchInput, _context: ToolExecutionContext, onProgress?: ToolCallProgress) => {
      onProgress?.({
        toolUseID: '',
        data: {
          type: 'searching',
          message: `Exa search: "${input.query}" (${input.type})`,
        },
      });
      return runExaSearch(input, options);
    },
  );
}
