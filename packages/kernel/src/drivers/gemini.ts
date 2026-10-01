import { AgyDriver, parseAgyEvent } from './agy.js';

// Backward compatibility alias: GeminiDriver delegates to AgyDriver
export class GeminiDriver extends AgyDriver {
  override readonly id = 'gemini';
}

export const parseGeminiEvent = parseAgyEvent;
