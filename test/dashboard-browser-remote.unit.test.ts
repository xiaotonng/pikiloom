import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBrowserStatusResponse } from '../src/dashboard/routes/config.ts';

// Minimal ManagedBrowserStatus stub mimicking a headless container with no
// local Chrome — the case where the pre-fix dashboard wrongly showed "chrome
// missing" while PIKICLAW_BROWSER_CDP_URL was actually driving a remote browser.
const headlessNoChrome = {
  status: 'chrome_missing' as const,
  profileDir: '/home/piki/.pikiclaw/browser/chrome-profile',
  profileCreated: false,
  chromeInstalled: false,
  running: false,
  pid: null,
  detail: 'Chrome is not available on this machine.',
  chromeExecutable: null,
  launchCommand: [] as string[],
};

describe('dashboard browser status — remote CDP mode (issue #16)', () => {
  const prev = process.env.PIKICLAW_BROWSER_CDP_URL;
  beforeEach(() => { delete process.env.PIKICLAW_BROWSER_CDP_URL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKICLAW_BROWSER_CDP_URL;
    else process.env.PIKICLAW_BROWSER_CDP_URL = prev;
  });

  it('surfaces the remote endpoint and explains remote mode when enabled', async () => {
    process.env.PIKICLAW_BROWSER_CDP_URL = 'http://chromium:9223';
    const { browser } = await buildBrowserStatusResponse({ browserEnabled: true } as any, headlessNoChrome);

    expect(browser.enabled).toBe(true);
    expect(browser.remoteCdpUrl).toBe('http://chromium:9223');
    expect(browser.detail).toMatch(/external Chrome over CDP/i);
  });

  it('does not surface a remote endpoint while browser automation is disabled', async () => {
    process.env.PIKICLAW_BROWSER_CDP_URL = 'http://chromium:9223';
    const { browser } = await buildBrowserStatusResponse({ browserEnabled: false } as any, headlessNoChrome);

    expect(browser.enabled).toBe(false);
    expect(browser.remoteCdpUrl).toBeNull();
  });

  it('reports null remoteCdpUrl in local managed mode (no env var)', async () => {
    const { browser } = await buildBrowserStatusResponse({ browserEnabled: true } as any, headlessNoChrome);

    expect(browser.remoteCdpUrl).toBeNull();
    expect(browser.status).toBe('chrome_missing');
  });
});
