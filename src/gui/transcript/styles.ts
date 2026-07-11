/** Extra CSS for specialized transcript tool cards, thinking, questions, scroll. */
export function getTranscriptStyles(): string {
  return `
/* ── Transcript overhaul ───────────────────────────────────────── */
.transcript-shell { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.transcript-shell .transcript { flex: 1; overflow: auto; padding-bottom: 12px; }
.transcript-jump {
  position: absolute; right: 18px; bottom: 14px; z-index: 5;
  display: none; align-items: center; gap: 6px;
  min-height: 32px; padding: 0 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-surface);
  color: var(--text-1); font: inherit; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12);
  cursor: pointer;
}
.transcript-jump.visible { display: inline-flex; }
.transcript-jump:hover { background: var(--surface-hover); }

.tool-card[data-family] header .tool-icon {
  width: 16px; height: 16px; flex: 0 0 auto; opacity: .7;
  display: inline-flex; align-items: center; justify-content: center;
}
.tool-card .tool-copy {
  opacity: 0; border: 0; background: transparent; color: var(--text-2);
  cursor: pointer; padding: 2px; border-radius: 4px; display: inline-flex;
}
.tool-card header:hover .tool-copy { opacity: 1; }
.tool-card .tool-copy:hover { background: var(--surface-hover); color: var(--text-1); }

/* Bash terminal body */
.tool-bash-body {
  margin: 0 8px 8px; padding: 10px 12px; border-radius: 8px;
  background: var(--code-bg); color: var(--code-fg); border: 1px solid var(--code-border);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12.5px; line-height: 1.45; overflow: auto; max-height: 280px; white-space: pre-wrap;
}
.tool-bash-cmd { color: var(--bash-cmd); margin-bottom: 6px; }
.tool-bash-cmd::before { content: "$ "; color: var(--bash-prompt); }
.tool-show-more {
  margin: 0 8px 8px; border: 0; background: transparent; color: var(--brand);
  font: inherit; font-size: 12px; cursor: pointer; padding: 0;
}

/* Edit / Write diff */
.tool-diff {
  margin: 0 8px 8px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border); font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; line-height: 1.45; max-height: 320px; overflow-y: auto;
}
.tool-diff-line { display: flex; gap: 0; white-space: pre-wrap; padding: 0 8px; }
.tool-diff-line.add { background: color-mix(in srgb, #16a34a 14%, transparent); }
.tool-diff-line.del { background: color-mix(in srgb, #dc2626 14%, transparent); }
.tool-diff-line.meta { color: var(--text-2); background: var(--surface-hover); }
.tool-diff-prefix { width: 14px; flex: 0 0 auto; opacity: .7; user-select: none; }
.tool-diff-line.add .tool-diff-prefix { color: #16a34a; }
.tool-diff-line.del .tool-diff-prefix { color: #dc2626; }
.tool-path-chip {
  display: inline-flex; align-items: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; color: var(--text-2);
}

/* Todo list */
.tool-todo-list { list-style: none; margin: 0 8px 8px; padding: 0; display: grid; gap: 4px; }
.tool-todo-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 8px;
  font-size: 13px; color: var(--text-1);
}
.tool-todo-item.completed { color: var(--text-2); text-decoration: line-through; }
.tool-todo-item.in_progress { background: color-mix(in srgb, var(--brand) 8%, transparent); }
.tool-todo-mark {
  width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--border);
  flex: 0 0 auto; margin-top: 2px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px;
}
.tool-todo-item.completed .tool-todo-mark { background: #16a34a; border-color: #16a34a; color: #fff; }
.tool-todo-item.in_progress .tool-todo-mark { border-color: var(--brand); color: var(--brand); }

/* Search / web results */
.tool-result-list { margin: 0 8px 8px; padding: 0; list-style: none; display: grid; gap: 6px; }
.tool-result-item {
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface);
}
.tool-result-item strong { display: block; font-size: 13px; }
.tool-result-item small { color: var(--text-2); font-size: 12px; }
.tool-result-item a { color: var(--brand); text-decoration: none; }
.tool-result-item a:hover { text-decoration: underline; }

/* Thinking card */
.thinking-card {
  max-width: 820px; margin: 0 auto 6px; border-radius: 8px; overflow: hidden;
}
.thinking-card header {
  display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 4px 8px;
  cursor: pointer; border-radius: 8px; color: var(--text-2); font-size: 13px; user-select: none;
}
.thinking-card header:hover { background: var(--surface-hover); }
.thinking-card .thinking-body {
  margin: 0 8px 8px; padding: 8px 10px; border-radius: 8px;
  background: var(--surface-hover); color: var(--text-2); font-size: 12.5px;
  white-space: pre-wrap; max-height: 220px; overflow: auto; line-height: 1.45;
}
.thinking-card.collapsed .thinking-body { display: none; }
.thinking-card.streaming header { color: var(--text-1); }

/* Permission / question footers */
.tool-approval-footer, .tool-question-footer {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin: 0 8px 10px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-surface);
}
.tool-approval-footer button, .tool-question-footer .q-submit, .tool-question-footer .q-skip {
  min-height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg-surface)); color: var(--text-1); font: inherit; font-size: 13px; cursor: pointer;
}
.tool-approval-footer button.primary, .tool-question-footer .q-submit {
  background: var(--brand); border-color: var(--brand); color: #fff;
}
.tool-approval-footer button:hover, .tool-question-footer .q-submit:hover, .tool-question-footer .q-skip:hover {
  filter: brightness(1.05);
}
.tool-question {
  margin: 0 8px 8px; display: grid; gap: 12px;
}
.tool-question-block { display: grid; gap: 6px; }
.tool-question-header {
  display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: var(--text-2);
}
.tool-question-text { font-size: 14px; color: var(--text-1); margin: 0; }
.tool-question-options { display: grid; gap: 6px; }
.tool-question-option {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-surface); cursor: pointer; font: inherit; color: inherit;
}
.tool-question-option.selected { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 10%, transparent); }
.tool-question-option strong { font-size: 13px; }
.tool-question-option small { color: var(--text-2); font-size: 12px; }
.tool-question-other {
  width: 100%; min-height: 34px; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-1); font: inherit;
}

/* Tool group (explore collapse) */
.tool-group {
  max-width: 820px; margin: 0 auto 6px; border-radius: 8px;
}
.tool-group > summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
  min-height: 28px; padding: 4px 8px; border-radius: 8px; color: var(--text-2); font-size: 13px;
}
.tool-group > summary::-webkit-details-marker { display: none; }
.tool-group > summary:hover { background: var(--surface-hover); }
.tool-group[open] > summary { color: var(--text-1); }
.tool-group .tool-group-body { padding-left: 8px; }

/* Message copy toolbar */
.msg-wrap { position: relative; }
.msg-copy-bar {
  position: absolute; top: 4px; right: 4px; display: none; gap: 4px;
}
.message-row:hover .msg-copy-bar { display: inline-flex; }
.msg-copy-bar button {
  border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-2);
  border-radius: 6px; min-height: 24px; padding: 0 8px; font-size: 11px; cursor: pointer;
}
.msg-copy-bar button:hover { color: var(--text-1); background: var(--surface-hover); }

body[data-density="compact"] .tool-card header { min-height: 24px; padding: 2px 6px; }
body[data-density="compact"] .tool-bash-body, body[data-density="compact"] .tool-diff { max-height: 200px; }
`;
}
