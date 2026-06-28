import { describe, expect, it } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import { formatEditCall } from '../src/tui/transcript.js';

describe('formatEditCall', () => {
  it('renders a header with the file path plus removed/added lines', () => {
    const lines = formatEditCall(
      { file_path: '/repo/src/a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
      80,
    );
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain('Edit');
    expect(plain[0]).toContain('/repo/src/a.ts');
    // One removed line, one added line.
    expect(plain.some(l => l.startsWith('- const x = 1;'))).toBe(true);
    expect(plain.some(l => l.startsWith('+ const x = 2;'))).toBe(true);
  });

  it('caps long diffs and reports the omitted count', () => {
    const oldMany = Array.from({ length: 10 }, (_, i) => `old ${i}`).join('\n');
    const newMany = Array.from({ length: 10 }, (_, i) => `new ${i}`).join('\n');
    const lines = formatEditCall(
      { file_path: '/f.ts', old_string: oldMany, new_string: newMany },
      80,
    );
    const plain = lines.map(stripAnsi);
    expect(plain.some(l => l.includes('+5 more'))).toBe(true);
    // Should show exactly 5 added + 5 removed before the cap note (the note
    // line itself also starts with "+ ", so exclude it from the count).
    const added = plain.filter(l => l.startsWith('+ ') && !l.includes('more'));
    expect(added.length).toBe(5);
  });

  it('handles a missing file_path and empty strings', () => {
    const lines = formatEditCall({ old_string: '', new_string: 'new line' }, 80);
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toContain('Edit');
    expect(plain.some(l => l.startsWith('+ new line'))).toBe(true);
  });
});
