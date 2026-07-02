import { describe, it, expect } from 'vitest';
import { kernelUsageToResultFields } from '../src/agent/kernel-bridge.js';

// Regression: the IM final footer (feishu/telegram formatFinalFooter) reads
// result.contextPercent. The bridge used to map the final kernel usage with
// contextPercent hardcoded to null, so the % showed on the live footer (preview
// meta carries it) but vanished from the finished message.
describe('kernel-bridge final usage projection', () => {
  it('carries contextPercent (and the token counts) into the final StreamResult fields', () => {
    const fields = kernelUsageToResultFields({
      inputTokens: 60_000,
      outputTokens: 150,
      cachedInputTokens: 12_000,
      contextUsedTokens: 72_150,
      contextPercent: 7.5,
      turnOutputTokens: 350,
    });
    expect(fields).toEqual({
      inputTokens: 60_000,
      outputTokens: 150,
      cachedInputTokens: 12_000,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: 72_150,
      contextPercent: 7.5,
    });
  });

  it('degrades to all-null fields when the kernel reported no usage', () => {
    expect(kernelUsageToResultFields({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
    });
    expect(kernelUsageToResultFields(null).contextPercent).toBeNull();
  });
});
