import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown } from '../src/gui/guiMarkdown.js';

describe('GUI markdown renderer', () => {
  it('escapes HTML to prevent injection', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders fenced code blocks with a copy button and escaped body', () => {
    const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
    expect(html).toContain('<pre class="code-block">');
    expect(html).toContain('class="copy-btn"');
    expect(html).toContain('1 &lt; 2');
  });

  it('renders inline code, bold, and headings', () => {
    expect(renderMarkdown('`x`')).toContain('<code class="inline-code">x</code>');
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('# Title')).toContain('<h1 class="md-h">Title</h1>');
  });

  it('linkifies only http(s) URLs', () => {
    expect(renderMarkdown('[ok](https://example.com)')).toContain('href="https://example.com"');
    const danger = renderMarkdown('[no](javascript:alert(1))');
    expect(danger).not.toContain('<a ');
  });

  it('is self-contained so its source can be shipped to the browser', () => {
    // renderMarkdown must not reference the module-level escapeHtml symbol,
    // because only its own .toString() is injected into the client script.
    expect(renderMarkdown.toString()).not.toMatch(/\bescapeHtml\b/);
  });

  it('renders ordered lists', () => {
    const html = renderMarkdown('1. first\n2. second');
    expect(html).toContain('<ol class="md-ol">');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
  });

  it('renders unordered lists and GFM task lists', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done\n- plain');
    expect(html).toContain('<ul class="md-ul">');
    expect(html).toContain('class="md-task"');
    expect(html).toContain('class="md-task md-task-done"');
    expect(html).toContain('checked');
    expect(html).toContain('<li>plain</li>');
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> a quoted line\n> and a second');
    expect(html).toContain('<blockquote class="md-quote">');
    expect(html).toContain('a quoted line');
  });

  it('renders GFM tables', () => {
    const md = '| Name | Age |\n|------|-----|\n| Ada  | 30  |\n| Bob  | 25  |';
    const html = renderMarkdown(md);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>Ada</td>');
    expect(html).toContain('<td>Bob</td>');
  });

  it('renders horizontal rules and strikethrough', () => {
    expect(renderMarkdown('---')).toContain('<hr class="md-hr">');
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
  });

  it('autolinks bare http(s) URLs but not those inside code', () => {
    const html = renderMarkdown('see https://example.com here');
    expect(html).toContain('href="https://example.com"');
    // A URL inside inline code must not be double-wrapped in an anchor.
    const code = renderMarkdown('`https://example.com`');
    expect(code).not.toContain('<a ');
  });

  it('does not mistake a single pipe line for a table', () => {
    // `a | b` is prose, not a table (no leading/trailing pipe + no separator).
    const html = renderMarkdown('a | b');
    expect(html).not.toContain('<table');
  });
});
