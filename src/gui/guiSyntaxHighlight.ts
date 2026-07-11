// Lightweight, dependency-free syntax highlighter for the GUI Files editor.
// `detectEditorLanguage` and `highlightCode` are intentionally self-contained
// so their source can be shipped to the browser via `.toString()` without
// depending on any other module-level symbol surviving the build.

export type EditorLanguage =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'json'
  | 'css'
  | 'html'
  | 'python'
  | 'rust'
  | 'go'
  | 'shell'
  | 'yaml'
  | 'sql'
  | 'java'
  | 'c'
  | 'cpp'
  | 'markdown'
  | 'plaintext';

/** Map a file path / basename to a highlighter language id. */
export function detectEditorLanguage(filePath: string): string {
  const base = String(filePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  const lower = base.toLowerCase();
  if (lower.endsWith('.d.ts')) return 'typescript';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'shell';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'shell';
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  const map = {
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'jsx',
    '.json': 'json',
    '.jsonc': 'json',
    '.css': 'css',
    '.scss': 'css',
    '.less': 'css',
    '.html': 'html',
    '.htm': 'html',
    '.svg': 'html',
    '.xml': 'html',
    '.py': 'python',
    '.pyi': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.ps1': 'shell',
    '.bat': 'shell',
    '.cmd': 'shell',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sql': 'sql',
    '.java': 'java',
    '.kt': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'java',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.mdx': 'markdown',
    '.toml': 'yaml',
    '.ini': 'yaml',
    '.cfg': 'yaml',
    '.conf': 'yaml',
    '.env': 'shell',
  };
  return (map as Record<string, string>)[ext] || 'plaintext';
}

/** True when the language should offer Markdown preview modes. */
export function isMarkdownLanguage(language: string): boolean {
  return language === 'markdown';
}

/**
 * Highlight source into HTML with `<span class="tok-…">` tokens.
 * Escapes all raw text; safe for innerHTML. Self-contained for browser ship.
 */
export function highlightCode(source: string, language?: string): string {
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

  const wrap = (cls: string, text: string) =>
    '<span class="tok-' + cls + '">' + esc(text) + '</span>';

  const lang = String(language || 'plaintext').toLowerCase();
  const text = String(source == null ? '' : source).replace(/\r\n/g, '\n');
  if (!text) return '';
  if (lang === 'plaintext' || lang === 'text' || lang === 'txt') return esc(text);

  const cComments = [
    { type: 'comment', re: /\/\/[^\n]*/y },
    { type: 'comment', re: /\/\*[\s\S]*?\*\//y },
  ];
  const hashComment = [{ type: 'comment', re: /#[^\n]*/y }];
  const stringsDqSq = [
    { type: 'string', re: /"(?:\\.|[^"\\])*"/y },
    { type: 'string', re: /'(?:\\.|[^'\\])*'/y },
  ];
  // Template literals: build the regex from char codes so Function#toString
  // never embeds a raw backtick (safe inside the GUI client template literal).
  const bt = String.fromCharCode(96);
  const template = [{
    type: 'string',
    re: new RegExp(bt + '(?:\\\\.|[^' + bt + '\\\\]|\\$\\{[^}]*\\})*' + bt, 'y'),
  }];
  const numberRule = {
    type: 'number',
    re: /\b(?:0x[0-9a-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y,
  };

  const kw = (words: string[]) => ({
    type: 'keyword',
    re: new RegExp('\\b(?:' + words.join('|') + ')\\b', 'y'),
  });

  const jsKeywords = [
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
    'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
    'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'return',
    'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
    'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'from', 'as', 'type',
    'namespace', 'declare', 'readonly', 'abstract', 'satisfies', 'infer', 'keyof',
    'unique', 'symbol', 'never', 'unknown', 'any', 'boolean', 'number', 'string',
    'object', 'bigint',
  ];

  const rulesFor = (id: string) => {
    if (id === 'json') {
      return [
        { type: 'string', re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
        { type: 'string', re: /"(?:\\.|[^"\\])*"/y },
        numberRule,
        kw(['true', 'false', 'null']),
      ];
    }
    if (id === 'css') {
      return [
        ...cComments,
        { type: 'string', re: /"(?:\\.|[^"\\])*"/y },
        { type: 'string', re: /'(?:\\.|[^'\\])*'/y },
        { type: 'meta', re: /@[a-zA-Z-]+/y },
        { type: 'number', re: /#(?:[0-9a-fA-F]{3,8})\b/y },
        numberRule,
        { type: 'attr', re: /--[\w-]+/y },
        kw([
          'important', 'and', 'or', 'not', 'only', 'from', 'to', 'var', 'calc',
          'min', 'max', 'clamp', 'rgb', 'rgba', 'hsl', 'hsla', 'url',
        ]),
      ];
    }
    if (id === 'html' || id === 'xml') {
      return [
        { type: 'comment', re: /<!--[\s\S]*?-->/y },
        { type: 'meta', re: /<\/?[a-zA-Z][\w:-]*/y },
        { type: 'attr', re: /\s+[\w:-]+(?=\s*=)/y },
        { type: 'string', re: /"(?:\\.|[^"\\])*"/y },
        { type: 'string', re: /'(?:\\.|[^'\\])*'/y },
      ];
    }
    if (id === 'python') {
      return [
        { type: 'comment', re: /#[^\n]*/y },
        { type: 'string', re: /"""[\s\S]*?"""/y },
        { type: 'string', re: /'''[\s\S]*?'''/y },
        { type: 'string', re: /f?"(?:\\.|[^"\\])*"/y },
        { type: 'string', re: /f?'(?:\\.|[^'\\])*'/y },
        numberRule,
        kw([
          'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
          'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
          'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
          'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
          'match', 'case',
        ]),
        { type: 'func', re: /\b[A-Za-z_][\w]*(?=\s*\()/y },
      ];
    }
    if (id === 'rust') {
      return [
        ...cComments,
        ...stringsDqSq,
        numberRule,
        kw([
          'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
          'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
          'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self',
          'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
          'where', 'while', 'yield',
        ]),
        { type: 'type', re: /\b[A-Z][\w]*\b/y },
      ];
    }
    if (id === 'go') {
      return [
        ...cComments,
        ...stringsDqSq,
        { type: 'string', re: new RegExp(bt + '[^' + bt + ']*' + bt, 'y') },
        numberRule,
        kw([
          'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
          'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
          'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
          'var', 'true', 'false', 'nil', 'iota',
        ]),
      ];
    }
    if (id === 'shell') {
      return [
        ...hashComment,
        ...stringsDqSq,
        { type: 'meta', re: /^#!.+$/my },
        { type: 'meta', re: /\$\{?[A-Za-z_][\w]*\}?/y },
        kw([
          'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
          'esac', 'function', 'return', 'in', 'select', 'time', 'until', 'export',
          'local', 'readonly', 'unset', 'true', 'false',
        ]),
      ];
    }
    if (id === 'yaml') {
      return [
        ...hashComment,
        { type: 'attr', re: /^[\t ]*[\w.-]+(?=\s*:)/my },
        ...stringsDqSq,
        numberRule,
        kw(['true', 'false', 'null', 'yes', 'no', 'on', 'off']),
      ];
    }
    if (id === 'sql') {
      return [
        { type: 'comment', re: /--[^\n]*/y },
        { type: 'comment', re: /\/\*[\s\S]*?\*\//y },
        ...stringsDqSq,
        numberRule,
        kw([
          'select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'values',
          'update', 'set', 'delete', 'create', 'table', 'index', 'drop', 'alter',
          'join', 'left', 'right', 'inner', 'outer', 'on', 'as', 'order', 'by',
          'group', 'having', 'limit', 'offset', 'union', 'all', 'distinct', 'null',
          'true', 'false', 'primary', 'key', 'foreign', 'references', 'constraint',
        ]),
      ];
    }
    if (id === 'java') {
      return [
        ...cComments,
        ...stringsDqSq,
        numberRule,
        kw([
          'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
          'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
          'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
          'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
          'package', 'private', 'protected', 'public', 'return', 'short', 'static',
          'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
          'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
          'var', 'record', 'sealed', 'permits', 'yield',
        ]),
        { type: 'type', re: /\b[A-Z][\w]*\b/y },
      ];
    }
    if (id === 'c' || id === 'cpp') {
      return [
        { type: 'meta', re: /#[^\n]*/y },
        ...cComments,
        ...stringsDqSq,
        numberRule,
        kw([
          'auto', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue',
          'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'extern',
          'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long',
          'mutable', 'namespace', 'new', 'operator', 'private', 'protected', 'public',
          'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
          'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename',
          'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while',
          'bool', 'nullptr', 'constexpr', 'noexcept',
        ]),
      ];
    }
    if (id === 'markdown') {
      return [
        { type: 'comment', re: /<!--[\s\S]*?-->/y },
        { type: 'string', re: new RegExp(bt + bt + bt + '[\\s\\S]*?' + bt + bt + bt, 'y') },
        { type: 'string', re: new RegExp(bt + '[^' + bt + '\\n]+' + bt, 'y') },
        { type: 'keyword', re: /^#{1,6}\s+.+$/my },
        { type: 'meta', re: /^\s*[-*+]\s+/my },
        { type: 'meta', re: /^\s*\d+\.\s+/my },
        { type: 'attr', re: /\[[^\]]+\]\([^)]+\)/y },
        { type: 'keyword', re: /\*\*[^*]+\*\*/y },
        { type: 'keyword', re: /__[^_]+__/y },
      ];
    }
    return [
      ...cComments,
      ...template,
      ...stringsDqSq,
      { type: 'regex', re: /\/(?![/*])(?:\\.|[^/\n\\])+\/[gimsuy]*/y },
      numberRule,
      kw(jsKeywords),
      { type: 'type', re: /\b[A-Z][\w]*\b/y },
      { type: 'func', re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y },
    ];
  };

  const rules = rulesFor(lang === 'tsx' || lang === 'jsx' ? 'typescript' : lang);
  let i = 0;
  let out = '';
  while (i < text.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(text);
      if (m && m.index === i) {
        const tokenType = rule.type === 'regex' ? 'string' : rule.type;
        out += wrap(tokenType, m[0]);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const start = i;
      i += 1;
      while (i < text.length) {
        let hit = false;
        for (const rule of rules) {
          rule.re.lastIndex = i;
          const m = rule.re.exec(text);
          if (m && m.index === i) { hit = true; break; }
        }
        if (hit) break;
        i += 1;
        if (i - start > 256) break;
      }
      out += esc(text.slice(start, i));
    }
  }
  return out;
}
