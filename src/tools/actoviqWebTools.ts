import { z } from 'zod';
import { tool } from '../runtime/tools.js';
import type {
  AgentToolDefinition,
  ModelRequest,
  ToolCallProgress,
  ToolExecutionContext,
  ToolProgressData,
} from '../types.js';
import { webFetchPrompt } from './prompts/webFetchPrompt.js';
import { webSearchPrompt } from './prompts/webSearchPrompt.js';

// ── WebFetch ──────────────────────────────────────────────────────

export interface WebFetchOptions {
  timeoutMs?: number;
  maxContentLength?: number;
}

const DEFAULT_FETCH_TIMEOUT = 15000;
const DEFAULT_MAX_CONTENT = 50000;

function createToolAbortSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timeout === 'object') {
    timeout.unref?.();
  }
  const abortFromParent = () => controller.abort();

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function createWebFetch(options: WebFetchOptions = {}): AgentToolDefinition {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT;
  const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT;

  return tool(
    {
      name: 'WebFetch',
      description:
        'Fetches content from a URL and processes it. ' +
        'The URL must be a fully-formed valid URL. HTTP URLs are upgraded to HTTPS. ' +
        'Provide a prompt to extract specific information from the page. ' +
        'IMPORTANT: You MUST never generate or guess URLs. ' +
        'Only use URLs provided by the user or found in previous tool results.',
      inputSchema: z.object({
        url: z.string().describe('The URL to fetch content from'),
        prompt: z
          .string()
          .optional()
          .describe(
            'What information to extract from the page. If omitted, returns the full text content.',
          ),
      }),
      isReadOnly: () => true,
      serialize: (output: WebFetchOutput) =>
        output.isError
          ? `Error fetching ${output.url}: ${output.error}`
          : `Fetched ${output.url} (${output.contentLength} chars)`,
      prompt: webFetchPrompt,
    },
    async (input, context, onProgress) => {
      const url = normalizeUrl(input.url);

      onProgress?.({
        toolUseID: '',
        data: { type: 'fetching', message: `Fetching ${url}`, url },
      });

      let abortSignal: ReturnType<typeof createToolAbortSignal> | undefined;
      try {
        abortSignal = createToolAbortSignal(timeoutMs, context.signal);

        const response = await fetch(url, {
          signal: abortSignal.signal,
          headers: {
            'User-Agent': 'ActoviqAgent/1.0',
            Accept: 'text/html, text/plain, */*',
          },
          redirect: 'follow',
        });

        if (!response.ok) {
          return {
            url,
            content: '',
            contentLength: 0,
            isError: true,
            error: `HTTP ${response.status} ${response.statusText}. The page could not be fetched. Try a different URL.`,
          } satisfies WebFetchOutput;
        }

        const contentType = response.headers.get('content-type') ?? '';
        const raw = await response.text();

        let content: string;
        if (contentType.includes('text/html')) {
          content = stripHtml(raw);
        } else {
          content = raw;
        }

        if (content.length > maxContentLength) {
          content = content.slice(0, maxContentLength) + '\n... (truncated)';
        }

        const resultText = input.prompt
          ? `URL: ${url}\n\nContent:\n${content}`
          : content;

        return {
          url,
          content: resultText,
          contentLength: resultText.length,
          isError: false,
        } satisfies WebFetchOutput;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = abortSignal?.timedOut() ?? false;
        return {
          url,
          content: '',
          contentLength: 0,
          isError: true,
          error: isTimeout
            ? `Request timed out after ${timeoutMs}ms. The server did not respond. Try a different URL.`
            : `Fetch failed: ${message}`,
        } satisfies WebFetchOutput;
      } finally {
        abortSignal?.cleanup();
      }
    },
  );
}

type WebFetchOutput = {
  url: string;
  content: string;
  contentLength: number;
  isError: boolean;
  error?: string;
};

// ── WebSearch ─────────────────────────────────────────────────────

export interface WebSearchOptions {
  timeoutMs?: number;
  maxResults?: number;
}

const DEFAULT_SEARCH_TIMEOUT = 20000;
const DEFAULT_MAX_RESULTS = 5;

function createWebSearch(options: WebSearchOptions = {}): AgentToolDefinition {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  return tool(
    {
      name: 'WebSearch',
      description:
        'Search the web and return results with titles, URLs, and snippets. ' +
        'IMPORTANT: You MUST include a "Sources:" section at the end of your response ' +
        'listing all relevant URLs from the search results as markdown hyperlinks.',
      inputSchema: z.object({
        query: z.string().min(2).describe('The search query'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum number of results. Defaults to ${maxResults}.`),
      }),
      isReadOnly: () => true,
      serialize: (output: WebSearchOutput) =>
        output.isError
          ? `Search error: ${output.error}`
          : output.results.length === 0
            ? `No results found for "${output.query}". Try a more specific or different query.`
            : output.results
                .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
                .join('\n\n'),
      prompt: webSearchPrompt,
    },
    async (input, context, onProgress) => {
      const limit = input.limit ?? maxResults;
      const query = input.query;

      onProgress?.({
        toolUseID: '',
        data: { type: 'searching', message: `Searching for "${query}"`, query },
      });

      // ── Server-side search via API proxy (like Claude Code) ──
      if (context.modelApi && context.provider !== 'openai') {
        const serverResult = await tryServerSearch(query, limit, context);
        if (serverResult && serverResult.results.length > 0) {
          return serverResult;
        }
        // Server search failed with an actual error (not just empty results)
        if (serverResult?.isError) {
          // Fall through to local search
        } else if (serverResult && !serverResult.isError) {
          return serverResult;
        }
      }

      // ── Local search (DuckDuckGo) ──
      const jsonResults = await tryJsonApi(query, limit, timeoutMs, context.signal);
      if (jsonResults.results.length > 0) {
        return jsonResults;
      }

      const htmlResults = await tryHtmlSearch(query, limit, timeoutMs, context.signal);
      if (htmlResults.results.length > 0) {
        return htmlResults;
      }

      const error = jsonResults.isError
        ? jsonResults.error
        : htmlResults.isError
          ? htmlResults.error
          : `No results found for "${query}"`;
      return {
        query,
        results: [],
        isError: true,
        error,
      } satisfies WebSearchOutput;
    },
  );
}

async function tryServerSearch(
  query: string,
  limit: number,
  context: ToolExecutionContext,
): Promise<WebSearchOutput | null> {
  try {
    const request: ModelRequest = {
      model: context.model ?? '',
      messages: [
        {
          role: 'user',
          content: `Perform a web search for the query: ${query}`,
        },
      ],
      max_tokens: 4096,
      system: 'You are an assistant for performing a web search tool use.',
      extra_tool_schemas: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
      signal: context.signal,
    };

    const message = await context.modelApi!.createMessage(request);

    // Extract web_search_tool_result blocks from the response
    const results: WebSearchResult[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray((block as Record<string, unknown>).content)) {
          for (const hit of (block as Record<string, unknown>).content as Array<{ title?: string; url?: string; snippet?: string }>) {
            if (results.length >= limit) break;
            if (hit.url) {
              results.push({
                title: hit.title ?? hit.url,
                url: hit.url,
                snippet: hit.snippet ?? '',
              });
            }
          }
        }
      }
    }

    if (results.length === 0) {
      // Server search returned no structured results — try extracting from text
      const text = message.content
        .filter((b) => b.type === 'text' && typeof (b as Record<string, unknown>).text === 'string')
        .map((b) => (b as Record<string, unknown>).text as string)
        .join('\n')
        .slice(0, 2000);
      return { query, results: [], isError: true, error: `Server search returned no results. Text: ${text.slice(0, 500)}` };
    }

    return {
      query,
      results: results.slice(0, limit),
      isError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { query, results: [], isError: true, error: `Server search failed: ${message}` };
  }
}

async function tryJsonApi(
  query: string,
  limit: number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<WebSearchOutput> {
  let abortSignal: ReturnType<typeof createToolAbortSignal> | undefined;
  try {
    abortSignal = createToolAbortSignal(timeoutMs, parentSignal);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, {
      signal: abortSignal.signal,
      headers: { 'User-Agent': 'ActoviqAgent/1.0' },
    });

    if (!response.ok) {
      return { query, results: [], isError: true, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as DuckDuckGoJsonResponse;
    const results: WebSearchResult[] = [];

    // Abstract (instant answer)
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || data.AbstractSource || 'Result',
        url: data.AbstractURL,
        snippet: data.AbstractText.slice(0, 300),
      });
    }

    // Related topics
    for (const topic of data.RelatedTopics ?? []) {
      if (results.length >= limit) break;
      if (!topic.FirstURL || !topic.Text) continue;
      results.push({
        title: topic.Text.split(' - ')[0]?.slice(0, 80) ?? topic.Text.slice(0, 80),
        url: topic.FirstURL,
        snippet: topic.Text.slice(0, 200),
      });
    }

    // Results array
    if (data.Results) {
      for (const item of data.Results) {
        if (results.length >= limit) break;
        if (!item.FirstURL || !item.Text) continue;
        // Dedup
        if (results.some((r) => r.url === item.FirstURL)) continue;
        results.push({
          title: item.Text.split(' - ')[0]?.slice(0, 80) ?? item.Text.slice(0, 80),
          url: item.FirstURL,
          snippet: item.Text.slice(0, 200),
        });
      }
    }

    if (results.length === 0) {
      return { query, results: [], isError: true, error: 'No results found from search API.' };
    }

    return { query, results: results.slice(0, limit), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { query, results: [], isError: true, error: `Search API failed: ${message}` };
  } finally {
    abortSignal?.cleanup();
  }
}

async function tryHtmlSearch(
  query: string,
  limit: number,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<WebSearchOutput> {
  let abortSignal: ReturnType<typeof createToolAbortSignal> | undefined;
  try {
    abortSignal = createToolAbortSignal(timeoutMs, parentSignal);

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      signal: abortSignal.signal,
      headers: { 'User-Agent': 'ActoviqAgent/1.0' },
    });

    if (!response.ok) {
      return { query, results: [], isError: true, error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const results = parseHtmlSearchResults(html, limit);

    if (results.length === 0) {
      return { query, results: [], isError: true, error: 'No results parsed from search page.' };
    }

    return { query, results, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { query, results: [], isError: true, error: `HTML search failed: ${message}` };
  } finally {
    abortSignal?.cleanup();
  }
}

type WebSearchResult = { title: string; url: string; snippet: string };

type WebSearchOutput = {
  query: string;
  results: WebSearchResult[];
  isError: boolean;
  error?: string;
};

interface DuckDuckGoJsonResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Heading?: string;
  RelatedTopics?: Array<{ FirstURL?: string; Text?: string }>;
  Results?: Array<{ FirstURL?: string; Text?: string }>;
}

// ── Factory ──────────────────────────────────────────────────────

export interface ActoviqWebToolsOptions {
  webFetch?: WebFetchOptions;
  webSearch?: WebSearchOptions;
}

export function createActoviqWebTools(
  options: ActoviqWebToolsOptions = {},
): AgentToolDefinition[] {
  return [createWebFetch(options.webFetch), createWebSearch(options.webSearch)];
}

// ── HTML helpers ──────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function parseHtmlSearchResults(
  html: string,
  limit: number,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // html.duckduckgo.com returns results in:
  // <a rel="nofollow" class="result__a" href="...">title</a>
  // <a class="result__snippet">snippet</a>
  const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const linkMatches = [...html.matchAll(linkPattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];

  for (let i = 0; i < linkMatches.length && results.length < limit; i++) {
    const link = linkMatches[i];
    const snippet = snippetMatches[i];
    if (!link?.[1]) continue;

    const url = decodeURIComponent(
      new URL(link[1], 'https://html.duckduckgo.com').searchParams.get('uddg') ?? link[1],
    );
    if (!url.startsWith('http')) continue;

    const title = stripHtml(decodeHtmlEntities(link[2]?.trim() ?? ''));
    if (!title || title.length < 2) continue;

    results.push({
      title,
      url,
      snippet: snippet?.[1]
        ? stripHtml(decodeHtmlEntities(snippet[1].trim())).slice(0, 200)
        : url,
    });
  }

  // Fallback: generic link extraction
  if (results.length === 0) {
    const genericLinks = html.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi) ?? [];
    for (const rawLink of genericLinks) {
      if (results.length >= limit) break;
      const href = rawLink.match(/href="([^"]*)"/)?.[1];
      const text = rawLink.match(/>([\s\S]*?)</)?.[1];
      if (!href || !text) continue;

      const url = decodeURIComponent(
        new URL(href, 'https://html.duckduckgo.com').searchParams.get('uddg') ?? href,
      );
      if (!url.startsWith('http')) continue;

      const cleanText = stripHtml(decodeHtmlEntities(text.trim()));
      if (cleanText.length < 3) continue;

      results.push({ title: cleanText.slice(0, 80), url, snippet: url });
    }
  }

  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normalizeUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return `https://${url}`;
}
