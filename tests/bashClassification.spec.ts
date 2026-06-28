import { describe, expect, it } from 'vitest';

import { isReadOnlyBashCommand } from '../src/runtime/bashClassification.js';

describe('isReadOnlyBashCommand', () => {
  it('auto-allows simple read-only commands', () => {
    expect(isReadOnlyBashCommand('ls -la')).toBe(true);
    expect(isReadOnlyBashCommand('cat README.md')).toBe(true);
    expect(isReadOnlyBashCommand('pwd')).toBe(true);
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('git log --oneline -5')).toBe(true);
    expect(isReadOnlyBashCommand('git diff')).toBe(true);
    expect(isReadOnlyBashCommand('git show HEAD')).toBe(true);
    expect(isReadOnlyBashCommand('git branch')).toBe(true);
    expect(isReadOnlyBashCommand('grep -r foo src/')).toBe(true);
    expect(isReadOnlyBashCommand('npm ls')).toBe(true);
    expect(isReadOnlyBashCommand('npm --version')).toBe(true);
    expect(isReadOnlyBashCommand('node --version')).toBe(true);
    expect(isReadOnlyBashCommand('echo hello')).toBe(true);
  });

  it('rejects commands that chain, pipe, redirect, or substitute', () => {
    expect(isReadOnlyBashCommand('ls; rm -rf /')).toBe(false);
    expect(isReadOnlyBashCommand('cat foo | grep bar')).toBe(false);
    expect(isReadOnlyBashCommand('ls > out.txt')).toBe(false);
    expect(isReadOnlyBashCommand('echo $(whoami)')).toBe(false);
    expect(isReadOnlyBashCommand('git status && git push')).toBe(false);
    expect(isReadOnlyBashCommand('ls &')).toBe(false);
  });

  it('rejects destructive commands even if they look read-only', () => {
    expect(isReadOnlyBashCommand('rm -rf node_modules')).toBe(false);
    expect(isReadOnlyBashCommand('git push --force origin main')).toBe(false);
    expect(isReadOnlyBashCommand('git reset --hard HEAD~1')).toBe(false);
    expect(isReadOnlyBashCommand('git clean -fd')).toBe(false);
    expect(isReadOnlyBashCommand('git branch -D feature')).toBe(false);
    expect(isReadOnlyBashCommand('chmod 777 .')).toBe(false);
  });

  it('rejects find -exec / -delete (can mutate)', () => {
    expect(isReadOnlyBashCommand('find . -exec rm {} \\;')).toBe(false);
    expect(isReadOnlyBashCommand('find . -delete')).toBe(false);
    // Plain find is read-only.
    expect(isReadOnlyBashCommand('find . -name "*.ts"')).toBe(true);
  });

  it('rejects mutating git/pkg subcommands (falls through to prompt)', () => {
    expect(isReadOnlyBashCommand('git config user.name X')).toBe(false);
    expect(isReadOnlyBashCommand('git stash')).toBe(false);
    expect(isReadOnlyBashCommand('git push')).toBe(false);
    expect(isReadOnlyBashCommand('npm install')).toBe(false);
    expect(isReadOnlyBashCommand('npm publish')).toBe(false);
  });

  it('rejects node/tsx running a script (only --version is read-only)', () => {
    expect(isReadOnlyBashCommand('node script.js')).toBe(false);
    expect(isReadOnlyBashCommand('node -e "console.log(1)"')).toBe(false);
    expect(isReadOnlyBashCommand('npx vitest')).toBe(false);
  });

  it('handles empty / unknown commands as not-read-only', () => {
    expect(isReadOnlyBashCommand('')).toBe(false);
    expect(isReadOnlyBashCommand('some-unknown-binary --flag')).toBe(false);
  });
});
