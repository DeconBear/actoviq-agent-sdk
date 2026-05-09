import type { ToolPromptOptions } from '../../types.js';

export function fileReadPrompt(_options: ToolPromptOptions): string {
  return `## Read Tool
- The Read tool reads a file from the local filesystem and returns numbered lines.
- You can access any file directly by using this tool.
- Usage:
  - \`file_path\` must be an absolute path, not a relative path.
  - By default, it reads up to 2000 lines starting from the beginning of the file.
  - When you already know which part of the file you need, only read that part.
  - You can use \`offset\` (1-based) and \`limit\` to read specific sections.
- This tool can also read images (PNG, JPG, etc.) and PDF files (use \`pages\` parameter).`;
}
