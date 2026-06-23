import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

describe('Gemini usage resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:00:00Z'));

    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-usage-'));
    process.env.HOME = homeDir;
    fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.gemini', 'oauth_creds.json'), JSON.stringify({
      access_token: 'gemini-token',
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('fetches live quota and caches it, then surfaces an HTTP error when the query fails uncached', async () => {
    {
      execSyncMock.mockReturnValue(JSON.stringify({
        buckets: [
          { modelId: 'gemini-2.5-flash', remainingFraction: 0.75, resetTime: '2026-03-16T00:30:00Z' },
          { modelId: 'gemini-2.5-pro', remainingFraction: 0.7, resetTime: '2026-03-16T01:00:00Z' },
          { modelId: 'gemini-3.1-flash-lite-preview', remainingFraction: 0.4, resetTime: '2026-03-16T00:45:00Z' },
          { modelId: 'gemini-3-pro-preview', remainingFraction: 0.9, resetTime: '2026-03-16T02:00:00Z' },
        ],
      }) + '\n200');

      const { getDriver } = await import('../src/agent/driver.ts');
      const { getUsage } = await import('../src/agent/index.ts');
      const driver = getDriver('gemini');

      const usage = await driver.getUsageLive!({ agent: 'gemini', model: 'gemini-2.5-pro' });

      expect(execSyncMock).toHaveBeenCalledOnce();
      expect(String(execSyncMock.mock.calls[0]?.[0])).toContain('cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('quota-api');
      expect(usage.status).toBe('allowed');
      expect(usage.windows.map(window => window.label)).toEqual(['Pro', 'Flash', 'Flash Lite']);
      expect(usage.windows.find(window => window.label === 'Pro')).toMatchObject({
        usedPercent: 30,
        remainingPercent: 70,
        resetAfterSeconds: 3600,
        status: 'allowed',
      });
      expect(usage.windows.find(window => window.label === 'Flash')).toMatchObject({
        usedPercent: 25,
        remainingPercent: 75,
        resetAfterSeconds: 1800,
      });
      expect(usage.windows.find(window => window.label === 'Flash Lite')).toMatchObject({
        usedPercent: 60,
        remainingPercent: 40,
        resetAfterSeconds: 2700,
      });

      const cached = getUsage({ agent: 'gemini' });
      expect(cached.ok).toBe(true);
      expect(cached.windows.map(window => window.label)).toEqual(['Pro', 'Flash', 'Flash Lite']);
    }

    vi.resetModules();
    execSyncMock.mockReset();

    {
      execSyncMock.mockReturnValue(JSON.stringify({ error: { message: 'invalid token' } }) + '\n401');

      const { getDriver } = await import('../src/agent/driver.ts');
      const { getUsage } = await import('../src/agent/index.ts');
      const driver = getDriver('gemini');

      const usage = await driver.getUsageLive!({ agent: 'gemini' });

      expect(usage.ok).toBe(false);
      expect(usage.error).toContain('HTTP 401');
      expect(usage.error).toContain('invalid token');
      expect(getUsage({ agent: 'gemini' }).ok).toBe(false);
    }
  });
});

describe('Gemini session tail', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-tail-'));
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('reads prior Gemini conversation turns from native session files', async () => {
    const workdir = '/tmp/pikiloom';
    const geminiDir = path.join(process.env.HOME!, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({
      projects: { [workdir]: 'pikiloom' },
    }));

    const chatsDir = path.join(geminiDir, 'tmp', 'pikiloom', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-00-abc.json'), JSON.stringify({
      sessionId: 'gemini-session-1',
      startTime: '2026-03-16T00:00:00.000Z',
      lastUpdated: '2026-03-16T00:01:00.000Z',
      messages: [
        { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: [{ text: 'first question' }] },
        { id: '2', timestamp: '2026-03-16T00:00:10.000Z', type: 'gemini', content: '' },
        { id: '3', timestamp: '2026-03-16T00:00:20.000Z', type: 'gemini', content: 'first answer' },
        { id: '4', timestamp: '2026-03-16T00:00:30.000Z', type: 'user', content: [{ text: 'follow up' }, { text: 'with detail' }] },
        { id: '5', timestamp: '2026-03-16T00:01:00.000Z', type: 'gemini', content: 'second answer' },
      ],
      kind: 'chat',
    }, null, 2));

    const { getSessionTail } = await import('../src/agent/index.ts');
    const tail = await getSessionTail({
      agent: 'gemini',
      sessionId: 'gemini-session-1',
      workdir,
      limit: 4,
    });

    expect(tail.ok).toBe(true);
    expect(tail.messages).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'follow up\nwith detail' },
      { role: 'assistant', text: 'second answer' },
    ]);
  });
});

describe('Gemini prompt builder', () => {
  it('embeds, quotes, and omits @-references depending on attachments', async () => {
    const { buildGeminiPromptText } = await import('../src/agent/drivers/gemini.ts');

    const prompt = buildGeminiPromptText('describe this image', ['/tmp/foo/shot.png']);
    expect(prompt).toContain('@/tmp/foo/shot.png');
    expect(prompt).toContain('describe this image');
    expect(prompt.indexOf('@/tmp/foo/shot.png')).toBeLessThan(prompt.indexOf('describe'));

    expect(buildGeminiPromptText('look', ['/tmp/has space/img.png'])).toContain('@"/tmp/has space/img.png"');

    expect(buildGeminiPromptText('hello', [])).toBe('hello');
  });
});

describe('Gemini session listing', () => {
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T00:02:00Z'));
    execSyncMock.mockReset();
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-sessions-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('reads native session titles, hides stub files, and returns empty when chats are missing', async () => {
    const { getSessions } = await import('../src/agent/index.ts');
    const workdir = '/tmp/pikiloom';

    const freshHome = () => {
      process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-sessions-'));
      const geminiDir = path.join(process.env.HOME!, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({
        projects: { [workdir]: 'pikiloom' },
      }));
      return geminiDir;
    };

    {
      const geminiDir = freshHome();
      const chatsDir = path.join(geminiDir, 'tmp', 'pikiloom', 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-00-abc.json'), JSON.stringify({
        sessionId: 'gemini-session-1',
        startTime: '2026-03-16T00:00:00.000Z',
        lastUpdated: '2026-03-16T00:01:00.000Z',
        messages: [
          { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: [{ text: 'How do I add dark mode to my React app with CSS variables?' }] },
        ],
        kind: 'chat',
      }, null, 2));

      const result = await getSessions({ agent: 'gemini', workdir, limit: 5 });

      expect(result.ok).toBe(true);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        sessionId: 'gemini-session-1',
        title: 'How do I add dark mode to my React app with CSS variables?',
        createdAt: '2026-03-16T00:00:00.000Z',
      });
      expect(execSyncMock).not.toHaveBeenCalled();
    }

    {
      const geminiDir = freshHome();
      const chatsDir = path.join(geminiDir, 'tmp', 'pikiloom', 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-00-a2a-serv.jsonl'),
        JSON.stringify({
          sessionId: 'a2a-server',
          projectHash: 'abc',
          startTime: '2026-03-16T00:00:00.000Z',
          lastUpdated: '2026-03-16T00:00:00.000Z',
          kind: 'main',
        }) + '\n');
      fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-01-abandon.jsonl'),
        JSON.stringify({
          sessionId: '70c89d0f-3276-4c21-9a1e-f9765098ab35',
          projectHash: 'abc',
          startTime: '2026-03-16T00:01:00.000Z',
          lastUpdated: '2026-03-16T00:01:00.000Z',
          kind: 'main',
        }) + '\n');
      fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-02-real.json'), JSON.stringify({
        sessionId: 'real-session',
        startTime: '2026-03-16T00:02:00.000Z',
        lastUpdated: '2026-03-16T00:02:30.000Z',
        messages: [
          { id: '1', timestamp: '2026-03-16T00:02:00.000Z', type: 'user', content: 'hi' },
        ],
        kind: 'main',
      }, null, 2));

      const result = await getSessions({ agent: 'gemini', workdir, limit: 10 });

      expect(result.ok).toBe(true);
      expect(result.sessions.map(s => s.sessionId)).toEqual(['real-session']);
    }

    {
      freshHome();

      const result = await getSessions({ agent: 'gemini', workdir, limit: 5 });

      expect(result.ok).toBe(true);
      expect(result.sessions).toHaveLength(0);
      expect(execSyncMock).not.toHaveBeenCalled();
    }
  });
});

describe('Gemini session messages content cleanup', () => {
  const originalHome = process.env.HOME;
  let workdir = '';

  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
    + '890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );

  beforeEach(() => {
    vi.resetModules();
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-msgs-'));
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gemini-msgs-work-'));
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function writeGeminiSession(messages: any[]): void {
    const geminiDir = path.join(process.env.HOME!, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({
      projects: { [workdir]: 'pikiloom-msgs' },
    }));
    const chatsDir = path.join(geminiDir, 'tmp', 'pikiloom-msgs', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, 'session-2026-03-16T00-00-abc.json'), JSON.stringify({
      sessionId: 'gemini-session-clean',
      startTime: '2026-03-16T00:00:00.000Z',
      lastUpdated: '2026-03-16T00:01:00.000Z',
      messages,
      kind: 'chat',
    }, null, 2));
  }

  it('cleans system preamble, promotes staged image refs, and leaves unresolved refs as text', async () => {
    const { getSessionMessages } = await import('../src/agent/index.ts');
    const read = () => getSessionMessages({
      agent: 'gemini', sessionId: 'gemini-session-clean', workdir, rich: true,
    });

    {
      const userContent = [
        '[Browser Automation]',
        'A Playwright MCP browser server is already configured...',
        'Do not call browser_install unless a browser tool explicitly reports that Chrome or the browser is missing.',
        'If you need a new tab, use browser_tabs with action="new".',
        '',
        'tell me a joke',
        '',
        '--- Content from referenced files ---',
        '',
        '--- End of content ---',
      ].join('\n');
      writeGeminiSession([
        { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: userContent },
        { id: '2', timestamp: '2026-03-16T00:00:10.000Z', type: 'gemini', content: 'sure' },
      ]);

      const result = await read();

      expect(result.ok).toBe(true);
      expect(result.messages[0]).toEqual({ role: 'user', text: 'tell me a joke' });
      expect(result.richMessages?.[0]).toEqual({
        role: 'user',
        text: 'tell me a joke',
        blocks: [{ type: 'text', content: 'tell me a joke' }],
      });
    }

    {
      const imageDir = path.join(workdir, '.pikiloom', 'sessions', 'gemini', 'pending_abc', 'workspace');
      fs.mkdirSync(imageDir, { recursive: true });
      fs.writeFileSync(path.join(imageDir, 'image.png'), PNG_BYTES);

      const userContent = [
        '[Browser Automation]',
        'noise line',
        '',
        '@.pikiloom/sessions/gemini/pending_abc/workspace/image.png',
        '',
        'what is in this image?',
        '',
        '--- Content from referenced files ---',
        '--- End of content ---',
      ].join('\n');
      writeGeminiSession([
        { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: userContent },
      ]);

      const result = await read();

      expect(result.ok).toBe(true);
      const rich = result.richMessages?.[0];
      expect(rich?.text).toBe('what is in this image?');
      expect(rich?.blocks?.[0]).toEqual({ type: 'text', content: 'what is in this image?' });
      expect(rich?.blocks?.[1]).toMatchObject({ type: 'image', imageMime: 'image/png' });
      expect(rich?.blocks?.[1]?.content).toMatch(/^data:image\/png;base64,/);
    }

    {
      writeGeminiSession([
        { id: '1', timestamp: '2026-03-16T00:00:00.000Z', type: 'user', content: 'check @docs/intro.md for context' },
      ]);

      const result = await read();

      expect(result.ok).toBe(true);
      expect(result.messages[0].text).toBe('check @docs/intro.md for context');
      expect(result.richMessages?.[0].blocks).toEqual([
        { type: 'text', content: 'check @docs/intro.md for context' },
      ]);
    }
  });
});
