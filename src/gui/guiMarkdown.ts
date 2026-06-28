// Minimal, dependency-free, XSS-safe markdown renderer for the GUI transcript.
// `renderMarkdown` is intentionally self-contained (it inlines its own escaper)
// so its source can be shipped to the browser via `renderMarkdown.toString()`
// without depending on any other module-level symbol surviving the build.
//
// Block-aware: fenced code, headings, horizontal rules, blockquotes, tables,
// ordered/unordered lists (incl. GFM task lists), and paragraphs. Inline:
// code, bold/italic (both **/__ and */_), strikethrough, http(s) links, and
// bare-URL autolinking.

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

  // Fenced code blocks -> NUL-delimited placeholders (escaped body + copy button
  // + optional language label). NUL never appears in model text, so the
  // placeholder can't collide with content.
  text = text.replace(/```[ \t]*([\w-]*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const index = codeBlocks.length;
    const langLabel = lang ? '<span class="code-lang">' + esc(lang) + '</span>' : '';
    codeBlocks.push(
      '<pre class="code-block">' + langLabel + '<button type="button" class="copy-btn">Copy</button><code>'
        + esc(String(code).replace(/\n$/, ''))
        + '</code></pre>',
    );
    return nul + index + nul;
  });

  // Inline formatting (operates on already-escaped text). `flow` additionally
  // turns single newlines into <br> for soft line breaks within a block.
  const inline = (raw: string): string => {
    let t = esc(raw);
    // Inline code (content is already escaped above).
    t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => '<code class="inline-code">' + code + '</code>');
    // Bold, then italic (both **/__ and */_).
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    // Strikethrough.
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // Markdown links — http/https only (rejects javascript: etc.).
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) => {
      const safeHref = String(href).replace(/&amp;/g, '&').replace(/"/g, '%22');
      return '<a href="' + safeHref + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    // Autolink bare http(s) URLs, but never inside an existing <a>/<code> span.
    const guarded: string[] = [];
    t = t.replace(/<a [^>]*>[\s\S]*?<\/a>/g, (m) => { guarded.push(m); return nul + (guarded.length - 1) + nul; });
    t = t.replace(/<code[^>]*>[\s\S]*?<\/code>/g, (m) => { guarded.push(m); return nul + (guarded.length - 1) + nul; });
    t = t.replace(/https?:\/\/[^\s<)\]]+/g, (url) => {
      const clean = url.replace(/[.,;:!?]+$/, '');
      const safe = clean.replace(/&amp;/g, '&').replace(/"/g, '%22');
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>';
    });
    t = t.replace(new RegExp(nul + '(\\d+)' + nul, 'g'), (_m, i: string) => guarded[Number(i)] ?? '');
    return t;
  };
  const flow = (raw: string): string => inline(raw).replace(/\n/g, '<br>');

  const isBlank = (l: string) => /^\s*$/.test(l);
  const isHr = (l: string) => /^\s*([-*_])\1{2,}\s*$/.test(l);
  const isHeading = (l: string) => /^(#{1,6})\s+\S/.test(l);
  const isUl = (l: string) => /^\s*[-*+]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);
  const isQuote = (l: string) => /^\s*>\s?/.test(l);
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l: string) => {
    const stripped = l.replace(/[\s|:]/g, '');
    return stripped.length > 0 && /^[ -]+$/.test(stripped) && stripped.includes('-');
  };
  // A fenced-code placeholder line is exactly <NUL><digits><NUL>. Checking by
  // char code avoids embedding a literal NUL byte in the source.
  const isPlaceholder = (l: string) => l.length > 2 && l.charCodeAt(0) === 0 && l.charCodeAt(l.length - 1) === 0;
  const isBlockStart = (l: string) =>
    isHr(l) || isHeading(l) || isUl(l) || isOl(l) || isQuote(l) || isTableRow(l) || isPlaceholder(l);

  const lines = text.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) { i += 1; continue; }
    // Standalone fenced code block — emit raw (restored at the end).
    if (isPlaceholder(line)) { blocks.push(line); i += 1; continue; }
    if (isHr(line)) { blocks.push('<hr class="md-hr">'); i += 1; continue; }
    if (isHeading(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/)!;
      const level = m[1]!.length;
      blocks.push('<h' + level + ' class="md-h">' + flow(m[2] ?? '') + '</h' + level + '>');
      i += 1; continue;
    }
    // GFM table: a header row whose next line is a separator.
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1] ?? '')) {
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && isTableRow(lines[j] ?? '')) { rows.push(lines[j] ?? ''); j += 1; }
      const parseRow = (r: string) =>
        r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = parseRow(rows[0] ?? '');
      const body = rows.slice(2).map(parseRow);
      let html = '<table class="md-table"><thead><tr>'
        + header.map((c) => '<th>' + flow(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const row of body) html += '<tr>' + row.map((c) => '<td>' + flow(c) + '</td>').join('') + '</tr>';
      html += '</tbody></table>';
      blocks.push(html);
      i = j; continue;
    }
    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && isQuote(lines[i] ?? '')) {
        quoteLines.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push('<blockquote class="md-quote">' + flow(quoteLines.join('\n')) + '</blockquote>');
      continue;
    }
    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      const lis = items.map((it) => {
        const tm = it.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) {
          const checked = tm[1] === 'x' || tm[1] === 'X';
          return '<li class="md-task' + (checked ? ' md-task-done' : '') + '">'
            + '<input type="checkbox" disabled' + (checked ? ' checked' : '') + '> '
            + flow(tm[2] ?? '') + '</li>';
        }
        return '<li>' + flow(it) + '</li>';
      });
      blocks.push('<ul class="md-ul">' + lis.join('') + '</ul>');
      continue;
    }
    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push('<ol class="md-ol">' + items.map((it) => '<li>' + flow(it) + '</li>').join('') + '</ol>');
      continue;
    }
    // Paragraph: gather consecutive non-blank, non-block-starting lines.
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i] ?? '') && !isBlockStart(lines[i] ?? '')) {
      para.push(lines[i] ?? ''); i += 1;
    }
    blocks.push('<p class="md-p">' + flow(para.join('\n')) + '</p>');
  }

  let html = blocks.join('');
  // Restore fenced code blocks.
  html = html.replace(new RegExp(nul + '(\\d+)' + nul, 'g'), (_m, index: string) => codeBlocks[Number(index)] ?? '');
  return html;
}
