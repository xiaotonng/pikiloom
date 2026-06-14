import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.fn();
const forceCloseMock = vi.fn();

vi.mock('../src/browser-profile.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/browser-profile.ts')>();
  return {
    ...actual,
    prepareManagedBrowserForAutomation: (...args: unknown[]) => prepareMock(...args),
    forceCloseManagedBrowser: (...args: unknown[]) => forceCloseMock(...args),
  };
});

const supervisor = await import('../src/browser-supervisor.ts');

describe('browser-supervisor', () => {
  beforeEach(() => {
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces concurrent ensure() calls, reuses cache, re-prepares after invalidate, and probe() works', async () => {
    // Helper: healthy fetch stub used across sub-scenarios
    const makeHealthyFetch = () => vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      if (url.endsWith('/json')) return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      return new Response('', { status: 404 });
    });

    // coalesces concurrent ensure() calls into a single prepare invocation
    prepareMock.mockResolvedValue({ profileDir: '/tmp/profile', closedPids: [], cdpEndpoint: 'http://127.0.0.1:39222', connectionMode: 'launch' });
    vi.stubGlobal('fetch', makeHealthyFetch());
    const [a, b, c] = await Promise.all([
      supervisor.ensureManagedBrowser(),
      supervisor.ensureManagedBrowser(),
      supervisor.ensureManagedBrowser(),
    ]);
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(a.cdpEndpoint).toBe('http://127.0.0.1:39222');
    expect(b.cdpEndpoint).toBe('http://127.0.0.1:39222');
    expect(c.cdpEndpoint).toBe('http://127.0.0.1:39222');

    // reuses the cached endpoint across calls instead of relaunching Chrome
    // (still cached from above — prepareMock stays at 1)
    await supervisor.ensureManagedBrowser();
    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(1);

    // re-prepares after invalidate() drops the cache
    supervisor.invalidateManagedBrowser();
    prepareMock.mockResolvedValue({ profileDir: '/tmp/profile', closedPids: [], cdpEndpoint: 'http://127.0.0.1:39222', connectionMode: 'attach' });
    vi.stubGlobal('fetch', makeHealthyFetch());
    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(2);

    // probe() returns the cached endpoint after a successful ensure()
    const probe = await supervisor.probeManagedBrowser();
    expect(probe.cdpEndpoint).toBe('http://127.0.0.1:39222');
    expect(prepareMock).toHaveBeenCalledTimes(2); // no extra prepare for probe

    // probe() does not trigger Chrome launch when nothing is cached
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    const emptyProbe = await supervisor.probeManagedBrowser();
    expect(prepareMock).not.toHaveBeenCalled();
    expect(emptyProbe).toEqual({ cdpEndpoint: null, connectionMode: 'unavailable' });
  });

  it('detects unhealthy CDP endpoints: /json timeout and non-array response both trigger re-prepare', async () => {
    prepareMock.mockResolvedValue({ profileDir: '/tmp/profile', closedPids: [], cdpEndpoint: 'http://127.0.0.1:39222', connectionMode: 'attach' });

    // /json/version alone as unhealthy when /json times out (stuck CDP dispatcher)
    let jsonShouldHang = false;
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) {
        return Promise.resolve(new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 }));
      }
      if (!jsonShouldHang) {
        return Promise.resolve(new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(1);

      jsonShouldHang = true;
      vi.setSystemTime(Date.now() + 60_000);

      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    // Reset between sub-scenarios
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    prepareMock.mockResolvedValue({ profileDir: '/tmp/profile', closedPids: [], cdpEndpoint: 'http://127.0.0.1:39222', connectionMode: 'attach' });
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    vi.unstubAllGlobals();

    // /json returning a non-array (e.g. error HTML) as unhealthy
    let jsonReturnsHtml = false;
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      if (jsonReturnsHtml) return new Response('<html>error</html>', { status: 200 });
      return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
    }));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(1);

      jsonReturnsHtml = true;
      vi.setSystemTime(Date.now() + 60_000);

      await supervisor.ensureManagedBrowser();
      expect(prepareMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restart clears cache, throttles, coalesces concurrent calls, and handles remote CDP mode', async () => {
    const makeHealthyFetch = () => vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' }), { status: 200 });
      if (url.endsWith('/json')) return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
      return new Response('', { status: 404 });
    });

    // restartManagedBrowser invokes forceClose and clears the cache
    prepareMock.mockResolvedValue({ profileDir: '/tmp/profile', closedPids: [], cdpEndpoint: 'http://127.0.0.1:39222', connectionMode: 'attach' });
    vi.stubGlobal('fetch', makeHealthyFetch());

    await supervisor.ensureManagedBrowser();
    expect(supervisor.getCachedManagedBrowserEndpoint()).toBe('http://127.0.0.1:39222');

    await supervisor.restartManagedBrowser('test');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);
    expect(supervisor.getCachedManagedBrowserEndpoint()).toBeNull();

    await supervisor.ensureManagedBrowser();
    expect(prepareMock).toHaveBeenCalledTimes(2);

    // restartManagedBrowser is throttled within the cooldown window
    // (reset first to get a clean throttle window)
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    vi.unstubAllGlobals();

    await supervisor.restartManagedBrowser('first');
    await supervisor.restartManagedBrowser('second');
    await supervisor.restartManagedBrowser('third');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);

    // concurrent restartManagedBrowser calls share a single in-flight force-close
    supervisor._resetManagedBrowserSupervisor();
    forceCloseMock.mockReset();
    let resolveForce: (() => void) | null = null;
    forceCloseMock.mockImplementation(() => new Promise<number[]>(r => {
      resolveForce = () => r([]);
    }));

    const ra = supervisor.restartManagedBrowser('a');
    const rb = supervisor.restartManagedBrowser('b');
    const rc = supervisor.restartManagedBrowser('c');
    expect(forceCloseMock).toHaveBeenCalledTimes(1);
    resolveForce!();
    await Promise.all([ra, rb, rc]);
    expect(forceCloseMock).toHaveBeenCalledTimes(1);

    // PIKILOOP_BROWSER_CDP_URL: bypasses local launch and attaches to remote endpoint
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    forceCloseMock.mockReset();
    forceCloseMock.mockResolvedValue([]);
    vi.unstubAllGlobals();

    process.env.PIKILOOP_BROWSER_CDP_URL = 'http://chromium:9222/';
    try {
      vi.stubGlobal('fetch', vi.fn(async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('http://chromium:9222/') && url.endsWith('/json/version')) {
          return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://chromium:9222/devtools/browser/x' }), { status: 200 });
        }
        if (url.startsWith('http://chromium:9222/') && url.endsWith('/json')) {
          return new Response(JSON.stringify([{ type: 'page', url: 'about:blank' }]), { status: 200 });
        }
        return new Response('', { status: 404 });
      }));

      const snap = await supervisor.ensureManagedBrowser();
      expect(snap.connectionMode).toBe('attach');
      expect(snap.cdpEndpoint).toBe('http://chromium:9222');
      expect(prepareMock).not.toHaveBeenCalled();

      await supervisor.restartManagedBrowser('remote test');
      expect(forceCloseMock).not.toHaveBeenCalled();
      expect(supervisor.getCachedManagedBrowserEndpoint()).toBeNull();
    } finally {
      delete process.env.PIKILOOP_BROWSER_CDP_URL;
    }

    // PIKILOOP_BROWSER_CDP_URL: reports unavailable when remote endpoint is unreachable
    supervisor._resetManagedBrowserSupervisor();
    prepareMock.mockReset();
    vi.unstubAllGlobals();

    process.env.PIKILOOP_BROWSER_CDP_URL = 'http://chromium:9222';
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
      const unreachableSnap = await supervisor.ensureManagedBrowser();
      expect(unreachableSnap.connectionMode).toBe('unavailable');
      expect(unreachableSnap.cdpEndpoint).toBeNull();
      expect(prepareMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.PIKILOOP_BROWSER_CDP_URL;
    }
  });
});
