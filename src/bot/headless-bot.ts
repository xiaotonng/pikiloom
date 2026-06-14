/**
 * HeadlessBot — the Web Dashboard acting as a first-class terminal.
 *
 * pikiloom's terminals (IM channels and the Dashboard) are equal, pluggable
 * entry points. The IM channels each have a Bot subclass that connects a chat
 * transport; the Dashboard needs no transport — it drives the bot directly via
 * `runtime.getBotRef()`. HeadlessBot fills that gap: it satisfies the Bot
 * contract (`run()` / `requestStop()`) so `ChannelSupervisor` can manage its
 * lifecycle exactly like a channel bot and the dashboard can attach to it for
 * live stream snapshots — but it connects to nothing.
 *
 * It exists so the bot is usable with zero IM channels configured: install an
 * agent, open the dashboard, and you have a working terminal. When an IM
 * channel is later added, the supervisor tears this down and the channel's bot
 * takes over the dashboard attachment.
 */
import { Bot } from './bot.js';

export class HeadlessBot extends Bot {
  private resolveRun: (() => void) | null = null;

  /**
   * No transport to connect — just mark the terminal live and block until
   * `requestStop()` so the supervisor's lifecycle (await runPromise on stop)
   * matches the channel bots'.
   */
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
