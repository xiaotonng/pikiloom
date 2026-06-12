import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectSetupState, isSetupReady } from '../src/cli/onboarding.ts';
import type { AgentInfo } from '../src/agent/index.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

// Channel transports fall back to these env vars; the dev shell often has some
// set, which would make resolveConfiguredChannels() see real channels. Clear
// them so the supervisor truly sees zero channels.
const CHANNEL_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_ALLOWED_CHAT_IDS',
  'WEIXIN_BASE_URL', 'WEIXIN_BOT_TOKEN', 'WEIXIN_ACCOUNT_ID',
  'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISCORD_BOT_TOKEN',
  'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'WECOM_BOT_ID', 'WECOM_BOT_SECRET',
] as const;

const ISOLATION_ENV_KEYS = ['PIKICLAW_CONFIG', 'PIKICLAW_WORKDIR', 'DEFAULT_AGENT', ...CHANNEL_ENV_KEYS] as const;

/** Point config at an isolated, channel-less setting.json (and strip channel
 *  env vars) so the supervisor resolves zero channels and never loads the
 *  host's real config. */
function isolatedChannellessConfig(): void {
  for (const key of CHANNEL_ENV_KEYS) delete process.env[key];
  const path = `${makeTmpDir('dash-terminal-config-')}/setting.json`;
  fs.writeFileSync(path, JSON.stringify({ version: 1 }));
  process.env.PIKICLAW_CONFIG = path;
  process.env.PIKICLAW_WORKDIR = makeTmpDir('dash-terminal-workdir-');
}

function agent(id: AgentInfo['agent'], installed: boolean): AgentInfo {
  return { agent: id, installed, path: installed ? `/usr/bin/${id}` : null, version: null };
}

const CLAUDE_ONLY = [agent('claude', true), agent('codex', false)];
const NONE = [agent('claude', false), agent('codex', false)];

describe('isSetupReady — dashboard is a first-class terminal', () => {
  it('is ready with an installed agent and NO channel configured', () => {
    const state = collectSetupState({ agents: CLAUDE_ONLY, channel: 'telegram', tokenProvided: false });
    expect(isSetupReady(state)).toBe(true);
  });

  it('is ready with both an agent and a channel', () => {
    const state = collectSetupState({ agents: CLAUDE_ONLY, channel: 'telegram', tokenProvided: true });
    expect(isSetupReady(state)).toBe(true);
  });

  it('is NOT ready when no agent is installed (channel alone is insufficient)', () => {
    const state = collectSetupState({ agents: NONE, channel: 'telegram', tokenProvided: true });
    expect(isSetupReady(state)).toBe(false);
  });
});

describe('HeadlessBot — dashboard terminal with no IM transport', () => {
  const envSnapshot = captureEnv(ISOLATION_ENV_KEYS);

  beforeEach(() => {
    restoreEnv(envSnapshot);
    isolatedChannellessConfig();
  });

  afterEach(() => restoreEnv(envSnapshot));

  it('reports connected while running and disconnects on requestStop', async () => {
    const { HeadlessBot } = await import('../src/bot/headless-bot.ts');
    const bot = new HeadlessBot();
    expect(bot.connected).toBe(false);

    let resolved = false;
    const runPromise = bot.run().then(() => { resolved = true; });
    expect(bot.connected).toBe(true);
    // run() blocks until stop — it must not resolve on its own.
    await Promise.resolve();
    expect(resolved).toBe(false);

    bot.requestStop();
    await runPromise;
    expect(resolved).toBe(true);
    expect(bot.connected).toBe(false);
  });
});

describe('ChannelSupervisor — headless attaches to the dashboard with zero channels', () => {
  const envSnapshot = captureEnv(ISOLATION_ENV_KEYS);

  beforeEach(() => {
    restoreEnv(envSnapshot);
    // No channel credentials → resolveConfiguredChannels() === [].
    isolatedChannellessConfig();
  });

  afterEach(() => restoreEnv(envSnapshot));

  it('starts a connected headless bot and attaches it to the dashboard', async () => {
    const { ChannelSupervisor } = await import('../src/cli/channel-supervisor.ts');
    const { loadUserConfig } = await import('../src/core/config/user-config.ts');

    const attached: { connected: boolean }[] = [];
    const dashboard = { attachBot: vi.fn((bot: { connected: boolean }) => attached.push(bot)) };

    const supervisor = new ChannelSupervisor({ dashboard: dashboard as any, log: () => {} });
    await supervisor.reconcile(loadUserConfig());

    expect(dashboard.attachBot).toHaveBeenCalledTimes(1);
    expect(attached[0]?.connected).toBe(true);

    // Idempotent: a second reconcile with the same (channel-less) config must
    // not spawn a second headless bot.
    await supervisor.reconcile(loadUserConfig());
    expect(dashboard.attachBot).toHaveBeenCalledTimes(1);

    await supervisor.stop();
    expect(attached[0]?.connected).toBe(false);
  });
});
