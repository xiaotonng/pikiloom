/**
 * Unit tests for the new channel credential validators (Slack / Discord /
 * DingTalk / WeChat Work). Each test stubs global fetch with a deterministic
 * response and asserts the resulting ChannelSetupState.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateDingtalkConfig,
  validateDiscordConfig,
  validateSlackConfig,
  validateWecomConfig,
} from '../src/core/config/validation.ts';

interface FetchStub {
  url: string;
  response: () => any;
  status?: number;
}

let stubs: FetchStub[] = [];

function setFetchStubs(next: FetchStub[]) {
  stubs = next;
  global.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const stub = stubs.find(s => url.includes(s.url));
    if (!stub) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify(stub.response()), { status: stub.status ?? 200 });
  }) as any;
}

beforeEach(() => {
  stubs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateSlackConfig', () => {
  it('reports missing, invalid, and ready states across all Slack credential combinations', async () => {
    const missing = await validateSlackConfig('', '');
    expect(missing.state.status).toBe('missing');

    const oneToken = await validateSlackConfig('xoxb-only', '');
    expect(oneToken.state.status).toBe('invalid');

    const badFormat = await validateSlackConfig('not-xoxb', 'xapp-foo');
    expect(badFormat.state.status).toBe('invalid');
    expect(badFormat.state.detail).toMatch(/xoxb-/);

    setFetchStubs([{ url: 'slack.com/api/auth.test', response: () => ({ ok: true, user_id: 'U1', user: 'pikiloop', team: 'TestTeam' }) }]);
    const ready = await validateSlackConfig('xoxb-test', 'xapp-test');
    expect(ready.state.status).toBe('ready');
    expect(ready.bot?.userId).toBe('U1');

    setFetchStubs([{ url: 'slack.com/api/auth.test', response: () => ({ ok: false, error: 'invalid_auth' }) }]);
    const authFailed = await validateSlackConfig('xoxb-test', 'xapp-test');
    expect(authFailed.state.status).toBe('invalid');
    expect(authFailed.state.detail).toMatch(/invalid_auth/);
  });
});

describe('validateDiscordConfig', () => {
  it('reports missing, ready, and invalid states across all Discord credential combinations', async () => {
    const missing = await validateDiscordConfig('');
    expect(missing.state.status).toBe('missing');

    setFetchStubs([{
      url: 'discord.com/api/v10/users/@me',
      response: () => ({ id: '1234567890', username: 'pikiloop', application_id: 'APP1' }),
    }]);
    const ready = await validateDiscordConfig('Bot-Token');
    expect(ready.state.status).toBe('ready');
    expect(ready.bot?.username).toBe('pikiloop');

    setFetchStubs([{
      url: 'discord.com/api/v10/users/@me',
      status: 401,
      response: () => ({ message: '401: Unauthorized' }),
    }]);
    const unauthorized = await validateDiscordConfig('Bot-Token');
    expect(unauthorized.state.status).toBe('invalid');
    expect(unauthorized.state.detail).toMatch(/401/);
  });
});

describe('validateDingtalkConfig and validateWecomConfig', () => {
  it('reports missing, invalid, and ready states across all DingTalk and WeCom credential combinations', async () => {
    // DingTalk
    const dtMissing = await validateDingtalkConfig('', '');
    expect(dtMissing.state.status).toBe('missing');

    const dtOneField = await validateDingtalkConfig('appkey-only', '');
    expect(dtOneField.state.status).toBe('invalid');

    setFetchStubs([{ url: 'oapi.dingtalk.com/gettoken', response: () => ({ errcode: 0, access_token: 'tok-abc', expires_in: 7200 }) }]);
    const dtReady = await validateDingtalkConfig('appkey', 'appsecret');
    expect(dtReady.state.status).toBe('ready');
    expect(dtReady.app?.clientId).toBe('appkey');

    setFetchStubs([{ url: 'oapi.dingtalk.com/gettoken', response: () => ({ errcode: 40001, errmsg: 'invalid credentials' }) }]);
    const dtTokenError = await validateDingtalkConfig('appkey', 'badsecret');
    expect(dtTokenError.state.status).toBe('invalid');
    expect(dtTokenError.state.detail).toMatch(/invalid credentials/);

    // WeCom
    const wcMissing = await validateWecomConfig('', '');
    expect(wcMissing.state.status).toBe('missing');

    const wcOneField = await validateWecomConfig('only-bot-id', '');
    expect(wcOneField.state.status).toBe('invalid');

    const wcReady = await validateWecomConfig('bot-id', 'bot-secret');
    expect(wcReady.state.status).toBe('ready');
    expect(wcReady.bot?.botId).toBe('bot-id');
  });
});
