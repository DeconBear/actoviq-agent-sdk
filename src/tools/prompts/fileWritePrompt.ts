import type { ToolPromptOptions } from '../../types.js';

export function fileWritePrompt(_options: ToolPromptOptions): string {
  return `## Write Tool
- Writes a file to the local filesystem.
- Usage:
  - This tool will overwrite the existing file if there is one at the provided path. You MUST use the Read tool first to read the file's contents.
  - Always prefer editing existing files using the Edit tool in the codebase. NEVER write new files unless explicitly required.
  - The \`file_path\` parameter must be an absolute path, not a relative path.
  - Parent directories will be created automatically if they do not exist.
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested by the User.`;
}
