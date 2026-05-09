import type { ToolPromptOptions } from '../../types.js';

export function fileEditPrompt(_options: ToolPromptOptions): string {
  return `## Edit Tool
- Performs exact string replacements in files. Prefer this over Write for modifying existing files.
- Usage:
  - You MUST read the file first before editing.
  - When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.
  - The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
  - Use \`replace_all\` for replacing and renaming strings across the file.
- The \`file_path\` parameter must be an absolute path.
- ALWAYS prefer editing existing files over writing new ones.`;
}
