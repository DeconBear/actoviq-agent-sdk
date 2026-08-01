import { describe, expect, it } from 'vitest';

import {
  buildReviewPrompt,
  parseReviewSummary,
  generateReviewSummary,
} from '../src/review/reviewSummaryService.js';

describe('reviewSummaryService', () => {
  describe('buildReviewPrompt', () => {
    it('includes the diff content', () => {
      const diff = 'diff --git a/foo.ts b/foo.ts\n+const x = 1;';
      const prompt = buildReviewPrompt(diff);
      expect(prompt).toContain('foo.ts');
      expect(prompt).toContain('+const x = 1;');
    });

    it('requires JSON output format', () => {
      const prompt = buildReviewPrompt('some diff');
      expect(prompt).toContain('"headline"');
      expect(prompt).toContain('"groups"');
      expect(prompt).toContain('valid JSON');
    });

    it('truncates very large diffs', () => {
      const bigDiff = 'x'.repeat(80_000);
      const prompt = buildReviewPrompt(bigDiff);
      expect(prompt).toContain('...[diff truncated]...');
      expect(prompt.length).toBeLessThan(80_000);
    });

    it('does not truncate small diffs', () => {
      const smallDiff = 'diff --git a/a.ts b/a.ts';
      const prompt = buildReviewPrompt(smallDiff);
      expect(prompt).not.toContain('truncated');
    });
  });

  describe('parseReviewSummary', () => {
    const validJson = JSON.stringify({
      headline: 'Added login feature',
      groups: [{
        title: 'User authentication',
        impact: 'added',
        description: 'Added a login form.',
        files: [{ path: 'src/login.ts', impact: 'added', summary: 'New login form' }],
      }],
      riskNotes: ['No rate limiting'],
    });

    it('parses pure JSON', () => {
      const result = parseReviewSummary(validJson, 'test-model');
      expect(result.headline).toBe('Added login feature');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.title).toBe('User authentication');
      expect(result.groups[0]!.impact).toBe('added');
      expect(result.groups[0]!.files[0]!.path).toBe('src/login.ts');
      expect(result.riskNotes).toEqual(['No rate limiting']);
      expect(result.model).toBe('test-model');
      expect(result.generatedAt).toBeTruthy();
    });

    it('parses JSON wrapped in markdown code fence', () => {
      const wrapped = '```json\n' + validJson + '\n```';
      const result = parseReviewSummary(wrapped, 'm');
      expect(result.headline).toBe('Added login feature');
      expect(result.groups).toHaveLength(1);
    });

    it('parses JSON with surrounding commentary', () => {
      const withText = 'Here is the summary:\n' + validJson + '\nLet me know if you need more.';
      const result = parseReviewSummary(withText, 'm');
      expect(result.headline).toBe('Added login feature');
    });

    it('normalizes invalid impact to modified', () => {
      const badImpact = JSON.stringify({
        headline: 'test',
        groups: [{ title: 'T', impact: 'destroyed', description: '', files: [] }],
      });
      const result = parseReviewSummary(badImpact, 'm');
      expect(result.groups[0]!.impact).toBe('modified');
    });

    it('returns fallback for completely invalid input', () => {
      const result = parseReviewSummary('This is not JSON at all', 'm');
      expect(result.headline).toBe('This is not JSON at all');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]!.title).toBe('Changes');
    });

    it('returns fallback for malformed JSON', () => {
      const result = parseReviewSummary('{ broken json !!!', 'm');
      expect(result.groups).toHaveLength(1);
      expect(result.model).toBe('m');
    });

    it('handles missing optional fields gracefully', () => {
      const minimal = JSON.stringify({ headline: 'Hi', groups: [] });
      const result = parseReviewSummary(minimal, 'm');
      expect(result.headline).toBe('Hi');
      expect(result.groups).toEqual([]);
      expect(result.riskNotes).toBeUndefined();
    });
  });

  describe('generateReviewSummary', () => {
    it('calls oneShotMessage and parses the result', async () => {
      const expectedJson = JSON.stringify({
        headline: 'Refactored utils',
        groups: [{ title: 'Utils cleanup', impact: 'refactored', description: 'Cleaned up.', files: [] }],
      });
      let capturedPrompt = '';
      const result = await generateReviewSummary({
        diff: 'diff --git a/util.ts b/util.ts\n-old\n+new',
        model: 'test-model',
        oneShotMessage: async (req) => { capturedPrompt = req.prompt; return expectedJson; },
      });
      expect(result.headline).toBe('Refactored utils');
      expect(result.model).toBe('test-model');
      expect(capturedPrompt).toContain('util.ts');
    });

    it('handles model returning non-JSON gracefully', async () => {
      const result = await generateReviewSummary({
        diff: 'some diff',
        model: 'm',
        oneShotMessage: async () => 'I cannot parse that diff, sorry.',
      });
      expect(result.headline).toBe('I cannot parse that diff, sorry.');
      expect(result.groups).toHaveLength(1);
    });
  });
});
