// Minimal, dependency-free, XSS-safe markdown renderer for the GUI transcript.
// `renderMarkdown` is intentionally self-contained (it inlines its own escaper)
// so its source can be shipped to the browser via `renderMarkdown.toString()`
// without depending on any other module-level symbol surviving the build.

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function renderMarkdown(source: string): string {
  const nul = String.fromCharCode(0);
  const esc = (value: unknown): string =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });

  const codeBlocks: string[] = [];
  let text = String(source == null ? '' : source).replace(/\r\n/g, '\n');

  // Fenced code blocks -> NUL-delimited placeholders (escaped body + copy button).
  // NUL never appears in model text, so the placeholder can't collide with content.
  text = text.replace(/```[ \t]*[\w-]*\n?([\s\S]*?)```/g, (_match, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(
      '<pre class="code-block"><button type="button" class="copy-btn">Copy</button><code>'
        + esc(String(code).replace(/\n$/, ''))
        + '</code></pre>',
    );
    return nul + index + nul;
  });

  // Everything else is escaped before inline formatting is applied.
  text = esc(text);

  // Inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => '<code class="inline-code">' + code + '</code>');
  // Headings.
  text = text.replace(/^(#{1,6})[ \t]+(.+)$/gm, (_m, hashes: string, body: string) => {
    const level = hashes.length;
    return '<h' + level + ' class="md-h">' + body + '</h' + level + '>';
  });
  // Bold, then italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Links — http/https only.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) => {
    const safeHref = String(href).replace(/&amp;/g, '&').replace(/"/g, '%22');
    return '<a href="' + safeHref + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // Unordered lists.
  text = text.replace(/(?:^|\n)((?:[ \t]*[-*][ \t]+.+(?:\n|$))+)/g, (_m, block: string) => {
    const items = String(block)
      .trim()
      .split('\n')
      .map((line) => '<li>' + line.replace(/^[ \t]*[-*][ \t]+/, '') + '</li>')
      .join('');
    return '\n<ul class="md-ul">' + items + '</ul>\n';
  });
  // Paragraphs / line breaks.
  text = text.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  // Trim stray <br> around block-level elements.
  text = text
    .replace(/<br>\s*(<(?:pre|ul|h[1-6]))/g, '$1')
    .replace(/(<\/(?:pre|ul|h[1-6])>)\s*<br>/g, '$1');
  // Restore fenced code blocks.
  text = text.replace(new RegExp(nul + '(\\d+)' + nul, 'g'), (_m, index: string) => codeBlocks[Number(index)] ?? '');

  return text;
}
