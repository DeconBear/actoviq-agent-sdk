import type { ToolPromptOptions } from '../../types.js';

export function fileSearchPrompt(_options?: any): string {
  return `## File Search Tools (Glob & Grep)

### Glob
- Fast file pattern matching tool for finding files by name patterns.
- Supports glob patterns like \`**/*.js\` or \`src/**/*.ts\`.
- Returns matching file paths sorted by modification time.
- Use this tool when you need to find files by name patterns.

### Grep
- A powerful search tool built on regular expressions for searching file contents.
- Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
  - Supports full regex syntax with \`pattern\` parameter.
  - Filter files with \`glob\` parameter (e.g., \`"*.js"\`, \`"**/*.tsx"\`).
  - Output modes: \`"content"\` shows matching lines, \`"files_with_matches"\` shows only file paths (default), \`"count"\` shows match counts.
  - Use \`head_limit\` to limit output. Pass 0 for unlimited.
  - Supports context lines (\`-A\`, \`-B\`, \`-C\`) and multiline mode.
- If you are searching for a keyword or file and are not confident that you will find the right match in the first few tries, keep searching with different patterns.`;
}
