import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBrowserStatusResponse } from '../src/dashboard/routes/config.ts';

const headlessNoChrome = {
  status: 'chrome_missing' as const,
  profileDir: '/home/piki/.pikiloom/browser/chrome-profile',
  profileCreated: false,
  chromeInstalled: false,
  running: false,
  pid: null,
  detail: 'Chrome is not available on this machine.',
  chromeExecutable: null,
  launchCommand: [] as string[],
};

describe('dashboard browser status — remote CDP mode (issue #16)', () => {
  const prev = process.env.PIKILOOM_BROWSER_CDP_URL;
  beforeEach(() => { delete process.env.PIKILOOM_BROWSER_CDP_URL; });
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_BROWSER_CDP_URL;
    else process.env.PIKILOOM_BROWSER_CDP_URL = prev;
  });

  it('surfaces remote endpoint when enabled, hides it when disabled, and returns null in local mode', async () => {
    process.env.PIKILOOM_BROWSER_CDP_URL = 'http://chromium:9223';
    const { browser: browser1 } = await buildBrowserStatusResponse({ browserEnabled: true } as any, headlessNoChrome);
    expect(browser1.enabled).toBe(true);
    expect(browser1.remoteCdpUrl).toBe('http://chromium:9223');
    expect(browser1.detail).toMatch(/external Chrome over CDP/i);

    const { browser: browser2 } = await buildBrowserStatusResponse({ browserEnabled: false } as any, headlessNoChrome);
    expect(browser2.enabled).toBe(false);
    expect(browser2.remoteCdpUrl).toBeNull();

    delete process.env.PIKILOOM_BROWSER_CDP_URL;
    const { browser: browser3 } = await buildBrowserStatusResponse({ browserEnabled: true } as any, headlessNoChrome);
    expect(browser3.remoteCdpUrl).toBeNull();
    expect(browser3.status).toBe('chrome_missing');
  });
});
