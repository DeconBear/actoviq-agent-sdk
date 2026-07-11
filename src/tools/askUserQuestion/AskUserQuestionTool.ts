import { z } from 'zod';
import { tool } from '../../runtime/tools.js';
import type { AgentToolDefinition } from '../../types.js';

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

const QuestionOptionSchema = z.object({
  label: z.string().describe('The display text for this option (1-5 words).'),
  description: z.string().describe('Explanation of what this option means.'),
  preview: z.string().optional().describe('Optional preview content rendered when focused (mockups, code snippets, etc.).'),
});

const QuestionSchema = z.object({
  question: z.string().describe('The complete question to ask. Should be clear, specific, and end with a question mark.'),
  header: z.string().describe('Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".'),
  options: z.array(QuestionOptionSchema).min(2).max(4).describe('Available choices (2-4 options). Each should be distinct, mutually exclusive (unless multiSelect). No "Other" option — provided automatically.'),
  multiSelect: z.boolean().default(false).describe('Set to true to allow multiple selections.'),
});

export const ASK_USER_QUESTION_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make it the first option and add "(Recommended)" at the end

Plan mode note: Use to clarify requirements or choose between approaches BEFORE finalizing your plan.
Preview feature: Use the optional preview field on options when presenting concrete artifacts.`;

export const ASK_USER_QUESTION_DESCRIPTION =
  'Ask the user multiple-choice questions. Use for gathering preferences, clarifying ambiguous instructions, or getting decisions on implementation choices.';

export function createAskUserQuestionTool(): AgentToolDefinition {
  return tool(
    {
      name: ASK_USER_QUESTION_TOOL_NAME,
      description: ASK_USER_QUESTION_DESCRIPTION,
      inputSchema: z.strictObject({
        questions: z.array(QuestionSchema).min(1).max(4).describe('Questions to ask the user (1-4 questions)'),
        answers: z.record(z.string(), z.string()).optional().describe('User answers collected by the permission component'),
      }),
      isReadOnly: () => true,
      // Force interactive approval even in bypassPermissions so the GUI/TUI can collect answers.
      requiresUserInteraction: () => true,
      prompt: () => ASK_USER_QUESTION_PROMPT,
    },
    async ({ questions, answers }) => {
      return { questions, answers: answers ?? {} };
    },
  );
}
