/**
 * Human-in-the-loop prompt state machine and answer helpers.
 */

export interface HumanLoopOption {
  label: string;
  description?: string | null;
  value: string;
}

export interface HumanLoopQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: HumanLoopOption[] | null;
  allowFreeform?: boolean;
  secret?: boolean;
  allowEmpty?: boolean;
}

export interface HumanLoopAnswerState {
  selectedValue: string | null;
  freeformText: string | null;
  awaitingFreeform: boolean;
  skipped: boolean;
}

export interface HumanLoopAnswerSummary {
  values: string[];
  display: string;
}

export interface HumanLoopPromptState<ChatId = number | string> {
  promptId: string;
  taskId: string;
  chatId: ChatId;
  title: string;
  detail?: string | null;
  hint?: string | null;
  questions: HumanLoopQuestion[];
  currentIndex: number;
  answers: Record<string, HumanLoopAnswerState>;
  resolveWith: (answers: Record<string, string[]>) => Record<string, any> | null;
  resolve: (response: Record<string, any> | null) => void;
  reject: (error: Error) => void;
  messageIds: Array<number | string>;
  /**
   * Internal pickers (channel-local command UIs) borrow the human-loop state
   * machine without being a real "agent asked a question" event. When true,
   * the post-resolution decision-echo hook is suppressed so /agents et al.
   * don't surface "✓ Answered · agent.switch" noise.
   */
  silent?: boolean;
}

export function createEmptyHumanLoopAnswer(): HumanLoopAnswerState {
  return {
    selectedValue: null,
    freeformText: null,
    awaitingFreeform: false,
    skipped: false,
  };
}

export function currentHumanLoopQuestion(prompt: HumanLoopPromptState): HumanLoopQuestion | null {
  return prompt.questions[prompt.currentIndex] || null;
}

export function isHumanLoopQuestionAnswered(prompt: HumanLoopPromptState, questionIndex: number): boolean {
  const question = prompt.questions[questionIndex];
  if (!question) return false;
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  if (answer.awaitingFreeform) return false;
  if (answer.skipped) return true;
  if (answer.selectedValue) return true;
  if (answer.freeformText && answer.freeformText.trim()) return true;
  return false;
}

export function humanLoopAnsweredCount(prompt: HumanLoopPromptState): number {
  let count = 0;
  for (let i = 0; i < prompt.questions.length; i++) {
    if (isHumanLoopQuestionAnswered(prompt, i)) count++;
  }
  return count;
}

export function isHumanLoopAwaitingText(prompt: HumanLoopPromptState): boolean {
  const question = currentHumanLoopQuestion(prompt);
  if (!question) return false;
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  if (answer.awaitingFreeform) return true;
  const hasOptions = !!question.options?.length;
  return !hasOptions;
}

export function humanLoopOptionSelected(prompt: HumanLoopPromptState, optionValue: string): boolean {
  const question = currentHumanLoopQuestion(prompt);
  if (!question) return false;
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  return answer.selectedValue === optionValue && !answer.awaitingFreeform;
}

export function setHumanLoopOption(
  prompt: HumanLoopPromptState,
  optionValue: string,
  opts: { requestFreeform?: boolean } = {},
): { completed: boolean; advanced: boolean } {
  const question = currentHumanLoopQuestion(prompt);
  if (!question) return { completed: false, advanced: false };
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  answer.selectedValue = opts.requestFreeform ? null : optionValue;
  answer.awaitingFreeform = !!opts.requestFreeform;
  answer.skipped = false;
  if (!opts.requestFreeform) answer.freeformText = null;
  prompt.answers[question.id] = answer;
  if (opts.requestFreeform) return { completed: false, advanced: false };
  return advanceHumanLoopPrompt(prompt);
}

export function setHumanLoopText(prompt: HumanLoopPromptState, text: string): { completed: boolean; advanced: boolean } {
  const question = currentHumanLoopQuestion(prompt);
  if (!question) return { completed: false, advanced: false };
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  answer.freeformText = text;
  answer.awaitingFreeform = false;
  answer.skipped = false;
  prompt.answers[question.id] = answer;
  return advanceHumanLoopPrompt(prompt);
}

export function skipHumanLoopQuestion(prompt: HumanLoopPromptState): { completed: boolean; advanced: boolean } {
  const question = currentHumanLoopQuestion(prompt);
  if (!question) return { completed: false, advanced: false };
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  answer.freeformText = null;
  answer.selectedValue = null;
  answer.awaitingFreeform = false;
  answer.skipped = true;
  prompt.answers[question.id] = answer;
  return advanceHumanLoopPrompt(prompt);
}

function advanceHumanLoopPrompt(prompt: HumanLoopPromptState): { completed: boolean; advanced: boolean } {
  if (prompt.currentIndex >= prompt.questions.length - 1) return { completed: true, advanced: false };
  prompt.currentIndex += 1;
  return { completed: false, advanced: true };
}

export function summarizeHumanLoopAnswer(prompt: HumanLoopPromptState, question: HumanLoopQuestion): HumanLoopAnswerSummary {
  const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
  const values: string[] = [];
  if (answer.selectedValue) values.push(answer.selectedValue);
  const freeform = answer.freeformText?.trim();
  if (freeform) values.push(freeform);
  const display = answer.skipped
    ? '(skip)'
    : values.length
      ? (question.secret ? '(hidden)' : values.join(' | '))
      : '(pending)';
  return {
    values,
    display,
  };
}

export function buildHumanLoopResponse(prompt: HumanLoopPromptState): Record<string, any> | null {
  const answers: Record<string, string[]> = {};
  for (const question of prompt.questions) {
    answers[question.id] = summarizeHumanLoopAnswer(prompt, question).values;
  }
  return prompt.resolveWith(answers);
}

/**
 * Lifecycle status of a resolved prompt — used by channels to pick the right
 * rendering (closed card vs cancelled card vs echo-only).
 */
export type ResolvedHumanLoopStatus = 'answered' | 'cancelled';

export interface ResolvedHumanLoopRow {
  /** Header label for the question, or the question prompt if no header. */
  label: string;
  /** Friendly display value (the option label when known, else the value). */
  display: string;
  /** True when this question was explicitly skipped. */
  skipped: boolean;
  /** True when the channel should treat the value as a secret. */
  secret: boolean;
}

export interface ResolvedHumanLoopAnswers {
  status: ResolvedHumanLoopStatus;
  rows: ResolvedHumanLoopRow[];
  /** Compact one-line answer summary suitable for echo messages. */
  display: string;
}

function displayValueForOption(question: HumanLoopQuestion, value: string): string {
  const match = question.options?.find(opt => opt.value === value);
  return match?.label || value;
}

/**
 * Build a channel-agnostic summary of a prompt's resolved answers. Used by the
 * base bot's `onInteractionAnswered` hook so each channel renders the same
 * closed-state view + echo message without diverging.
 */
export function summarizeResolvedHumanLoopAnswers(
  prompt: HumanLoopPromptState,
  status: ResolvedHumanLoopStatus = 'answered',
): ResolvedHumanLoopAnswers {
  const rows: ResolvedHumanLoopRow[] = [];
  const compactParts: string[] = [];
  for (const question of prompt.questions) {
    const answer = prompt.answers[question.id] || createEmptyHumanLoopAnswer();
    let display: string;
    if (answer.skipped) {
      display = '(skip)';
    } else if (question.secret && (answer.selectedValue || answer.freeformText)) {
      display = '(hidden)';
    } else {
      const parts: string[] = [];
      if (answer.selectedValue) parts.push(displayValueForOption(question, answer.selectedValue));
      const freeform = answer.freeformText?.trim();
      if (freeform) parts.push(freeform);
      display = parts.length ? parts.join(' · ') : '(no answer)';
    }
    const label = (question.header || question.prompt || question.id).trim();
    rows.push({
      label,
      display,
      skipped: !!answer.skipped,
      secret: !!question.secret,
    });
    compactParts.push(display);
  }
  return {
    status,
    rows,
    display: compactParts.join(' · '),
  };
}
