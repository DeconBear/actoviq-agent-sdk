import type { ToolPromptOptions } from '../../types.js';

export function webSearchPrompt(_options: ToolPromptOptions): string {
  return `## WebSearch Tool
- Searches the web and returns results with titles, URLs, and snippets.
- Uses DuckDuckGo for zero-configuration searching.
- Usage:
  - The \`query\` parameter must be at least 2 characters.
  - Use \`limit\` to control the number of results (default: 5, max recommended: 10).
  - Domain filtering is supported to include or block specific websites.

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response

IMPORTANT: If you need up-to-date information or information beyond your knowledge cutoff, use this tool.`;
}
