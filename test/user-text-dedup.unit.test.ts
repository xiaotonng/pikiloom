import { describe, expect, it } from 'vitest';
import { normalizeUserText, sameUserText } from '../dashboard/src/pages/sessions/utils';

describe('sameUserText (image-dedup whitespace robustness)', () => {
  it('matches a multi-line prompt against its whitespace-collapsed transcript form', () => {
    const raw = 'What is in this image?\nAlso, what does the README say?';
    const collapsed = 'What is in this image? Also, what does the README say?';
    expect(sameUserText(raw, collapsed)).toBe(true);
  });

  it('treats trailing/leading and doubled whitespace as equal', () => {
    expect(sameUserText('  hello   world \n', 'hello world')).toBe(true);
    expect(sameUserText('line1\n\nline2', 'line1 line2')).toBe(true);
  });

  it('still distinguishes genuinely different messages', () => {
    expect(sameUserText('那这个报告说的是什么', '换一个问题')).toBe(false);
  });

  it('normalizes null/undefined to empty', () => {
    expect(normalizeUserText(null)).toBe('');
    expect(normalizeUserText(undefined)).toBe('');
    expect(sameUserText('', null)).toBe(true);
  });
});
