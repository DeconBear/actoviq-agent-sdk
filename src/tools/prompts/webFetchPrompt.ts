import type { ToolPromptOptions } from '../../types.js';

export function webFetchPrompt(_options: ToolPromptOptions): string {
  return `## WebFetch Tool
- Fetches content from a specified URL and processes it.
- Usage:
  - The URL must be a fully-formed valid URL.
  - HTTP URLs will be automatically upgraded to HTTPS.
  - The \`prompt\` parameter describes what information to extract from the page.
  - This tool is read-only and does not modify any files.
  - Results may be summarized if the content is very large (max ~50KB).
  - IMPORTANT: You MUST never generate or guess URLs. Only use URLs provided by the user or found in previous tool results.
- For GitHub URLs, prefer using the gh CLI tool instead when available.`;
}
