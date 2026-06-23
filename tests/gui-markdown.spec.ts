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
});
