import { describe, expect, it } from 'vitest';

import {
  detectEditorLanguage,
  highlightCode,
  isMarkdownLanguage,
} from '../src/gui/guiSyntaxHighlight.js';

describe('guiSyntaxHighlight', () => {
  it('detects languages from common extensions', () => {
    expect(detectEditorLanguage('src/foo.ts')).toBe('typescript');
    expect(detectEditorLanguage('a.tsx')).toBe('tsx');
    expect(detectEditorLanguage('x.js')).toBe('javascript');
    expect(detectEditorLanguage('pkg.json')).toBe('json');
    expect(detectEditorLanguage('styles.css')).toBe('css');
    expect(detectEditorLanguage('index.html')).toBe('html');
    expect(detectEditorLanguage('main.py')).toBe('python');
    expect(detectEditorLanguage('lib.rs')).toBe('rust');
    expect(detectEditorLanguage('main.go')).toBe('go');
    expect(detectEditorLanguage('README.md')).toBe('markdown');
    expect(detectEditorLanguage('notes.markdown')).toBe('markdown');
    expect(detectEditorLanguage('actoviqSettingsStore.d.ts')).toBe('typescript');
    expect(detectEditorLanguage('weird.bin')).toBe('plaintext');
  });

  it('flags markdown languages for preview modes', () => {
    expect(isMarkdownLanguage('markdown')).toBe(true);
    expect(isMarkdownLanguage('typescript')).toBe(false);
  });

  it('escapes HTML and colors keywords/strings', () => {
    const html = highlightCode('const x = "<ok>"; // hi', 'javascript');
    expect(html).toContain('tok-keyword');
    expect(html).toContain('tok-string');
    expect(html).toContain('tok-comment');
    expect(html).toContain('&lt;ok&gt;');
    expect(html).not.toContain('<ok>');
  });

  it('highlights json keys and values', () => {
    const html = highlightCode('{"a": 1, "b": true}', 'json');
    expect(html).toContain('tok-string');
    expect(html).toContain('tok-number');
    expect(html).toContain('tok-keyword');
  });

  it('returns escaped plaintext without token spans', () => {
    expect(highlightCode('a < b', 'plaintext')).toBe('a &lt; b');
  });

  it('ships self-contained highlightCode / detectEditorLanguage for the browser', () => {
    expect(highlightCode.toString()).not.toMatch(/\bescapeHtml\b/);
    expect(detectEditorLanguage.toString()).not.toMatch(/\bisMarkdownLanguage\b/);
  });
});
