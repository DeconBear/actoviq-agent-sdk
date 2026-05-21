import { describe, expect, it } from 'vitest';

import { checkSafety } from '../src/runtime/safetyChecks.js';

function check(filePath: string) {
  return checkSafety({
    toolName: 'Write',
    publicName: 'Write',
    toolInput: { file_path: filePath },
    workDir: process.cwd(),
  });
}

describe('safety checks', () => {
  it('blocks protected directories with slash or backslash paths', () => {
    expect(check('C:/repo/.git/config').blocked).toBe(true);
    expect(check('C:\\repo\\.actoviq\\settings.json').blocked).toBe(true);
  });

  it('blocks nested shell configuration files on Windows-style paths', () => {
    const result = check('C:/Users/demo/.config/fish/config.fish');

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('fish/config.fish');
  });
});
