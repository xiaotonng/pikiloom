import { Bot } from './bot.js';

export class HeadlessBot extends Bot {
  private resolveRun: (() => void) | null = null;

  public run(): Promise<void> {
    this.connected = true;
    this.log('dashboard terminal ready (no IM channel configured)');
    return new Promise<void>(resolve => { this.resolveRun = resolve; });
  }

  public requestStop(): void {
    this.connected = false;
    super.requestStop();
    this.resolveRun?.();
    this.resolveRun = null;
  }
}
