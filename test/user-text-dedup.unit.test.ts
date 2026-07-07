import { describe, expect, it } from 'vitest';
import {
  displayPromptForPending,
  latestOwnPlan,
  normalizeUserText,
  promptEndsWithUserPrompt,
  sameUserText,
  shouldCarryLatestPlanIntoLiveStream,
  streamPromptMatchesTurnText,
} from '../dashboard/src/pages/sessions/utils';
import type { MessageBlock } from '../dashboard/src/types';

function planBlock(steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>): MessageBlock {
  return { type: 'plan', content: '', plan: { explanation: null, steps } };
}
const toolBlock: MessageBlock = { type: 'tool_use', content: '', toolName: 'Bash' };
const textBlock: MessageBlock = { type: 'text', content: 'done' };

// shortValue(text, 500): first (500-3) chars, trimEnd, + '...'
function shortValue(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

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

describe('streamPromptMatchesTurnText (truncated managed-fallback dedup)', () => {
  // The bug: a new long-prompt session shows the user message twice during streaming —
  // a truncated managed-fallback history turn (shortValue→500) plus the full live-question
  // bubble — because plain sameUserText(truncated, full) is false. This helper must match.
  const longEn =
    'Without using any tools and without reading any files, write a slow reflective essay. '
    + 'Count from 1 to 25 and for each number output the number on its own line followed by a '
    + 'short original one-sentence reflection about software architecture, layering, or '
    + 'orthogonality. Take your time and produce each line deliberately so the output streams '
    + 'gradually. After reaching 25 write a two-sentence conclusion about why clean layering '
    + 'matters. Do not call any tool. This prompt is intentionally long so it resembles a '
    + 'realistic multi-paragraph instruction sent together with an attached screenshot image.';
  const longZh =
    '我希望完整的初始化整个项目。你看这里的定义，Model 层的服务是其他人提供的，你这里只要有一个底层能够跨领域调用模型的方式即可。'.repeat(20);

  it('matches the 500-char truncated preview against the full English prompt', () => {
    const truncated = shortValue(longEn, 500);
    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(sameUserText(truncated, longEn)).toBe(false); // plain dedup fails (the bug)
    expect(streamPromptMatchesTurnText(truncated, longEn)).toBe(true);
  });

  it('matches the truncated preview against a CJK prompt (no word boundaries)', () => {
    const truncated = shortValue(longZh, 500);
    expect(sameUserText(truncated, longZh)).toBe(false);
    expect(streamPromptMatchesTurnText(truncated, longZh)).toBe(true);
  });

  it('still matches when the transcript collapses whitespace differently at the cut', () => {
    const truncated = shortValue(longEn, 500).replace(/\s+/g, '  '); // doubled spaces
    expect(streamPromptMatchesTurnText(truncated, longEn)).toBe(true);
  });

  it('does NOT match an unrelated earlier turn that merely ends with an ellipsis', () => {
    expect(streamPromptMatchesTurnText('Summarize the meeting notes...', longEn)).toBe(false);
  });

  it('does NOT prefix-match a turn without a truncation ellipsis', () => {
    // A full (non-truncated) earlier turn that happens to be a prefix must not match.
    const prefixNoEllipsis = longEn.slice(0, 120);
    expect(streamPromptMatchesTurnText(prefixNoEllipsis, longEn)).toBe(false);
  });

  it('does NOT match a short truncated-looking turn (too little shared prefix)', () => {
    expect(streamPromptMatchesTurnText('ok...', longEn)).toBe(false);
  });

  it('keeps exact equality working for short prompts (no truncation)', () => {
    expect(streamPromptMatchesTurnText('What is in this image?', 'What is in this image?')).toBe(true);
    expect(streamPromptMatchesTurnText('换一个问题', '那这个报告说的是什么')).toBe(false);
  });
});

describe('handover prompt pending dedup', () => {
  it('treats a handover seed plus current user prompt as one display prompt', () => {
    const prompt = 'default login 又没有了，而且左下角也没有 claude用量了，请你仔细完备修复这个问题';
    const full = [
      '<handover from="claude" to="codex" turns="9">',
      'User: 我刚才更新了最新的 kernel',
      'Assistant: 当前情况清晰了。',
      '</handover>',
      '[Continuing this conversation. The previous turns above ran under claude; you are now codex picking up where it left off. Your next user message follows.]',
      '',
      prompt,
    ].join('\n');

    expect(promptEndsWithUserPrompt(full, prompt)).toBe(true);
    expect(displayPromptForPending(prompt, full)).toBe(full);
  });

  it('does not merge unrelated live questions with the pending prompt', () => {
    expect(promptEndsWithUserPrompt('Please fix auth', 'Please fix usage')).toBe(false);
    expect(displayPromptForPending('Please fix usage', 'Please fix auth')).toBe('Please fix usage');
  });
});

describe('live plan fallback isolation', () => {
  it('does not carry the previous plan into a new live user turn', () => {
    expect(shouldCarryLatestPlanIntoLiveStream('fix the dashboard', null)).toBe(false);
    expect(shouldCarryLatestPlanIntoLiveStream(null, 'fix the dashboard')).toBe(false);
  });

  it('does not carry the previous plan into a handover live question', () => {
    const prompt = 'continue fixing layout';
    const handover = `<handover>prior transcript</handover>\n${prompt}`;
    expect(shouldCarryLatestPlanIntoLiveStream(prompt, handover)).toBe(false);
  });

  it('allows the fallback only when there is no current live question', () => {
    expect(shouldCarryLatestPlanIntoLiveStream(null, null)).toBe(true);
    expect(shouldCarryLatestPlanIntoLiveStream('', '')).toBe(true);
  });
});

describe('settled turn shows only its own plan', () => {
  it('returns a turn\'s own latest plan block (latest wins within the turn)', () => {
    const blocks = [
      planBlock([{ step: 'design', status: 'completed' }, { step: 'build', status: 'inProgress' }]),
      planBlock([{ step: 'design', status: 'completed' }, { step: 'build', status: 'completed' }]),
    ];
    expect(latestOwnPlan(blocks)?.steps).toEqual([
      { step: 'design', status: 'completed' },
      { step: 'build', status: 'completed' },
    ]);
  });

  it('returns null for a plan-less turn — never inheriting an earlier turn\'s plan', () => {
    // The bug: a new, unrelated reply (tool activity + text, no todo write of its own) used to
    // borrow the previous turn's completed plan via a session-level fallback. A plan-less turn
    // must resolve to no plan card at all.
    expect(latestOwnPlan([toolBlock, textBlock])).toBeNull();
    expect(latestOwnPlan([])).toBeNull();
    // An empty-steps plan block is not a plan.
    expect(latestOwnPlan([planBlock([])])).toBeNull();
  });
});
