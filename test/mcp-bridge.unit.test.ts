import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getConfiguredRemoteCdpUrl,
  getManagedBrowserProfileDir,
  resolveManagedBrowserMcpCommand,
} from '../src/browser-profile.ts';
import {
  _matchPlaywrightMcpProcessCommand,
  buildGuiSetupHints,
  buildSupplementalMcpServers,
  resolveBridgeBrowserEndpoint,
  resolveGuiIntegrationConfig,
  resolveMcpServerCommand,
  resolveSendFilePath,
} from '../src/agent/mcp/bridge.ts';
import { makeTmpDir } from './support/env.ts';

function writeFile(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('resolveMcpServerCommand', () => {
  it('reuses the current CLI entrypoint from source and falls back to the compiled session server', () => {
    // --- Source entrypoint scenario ---
    const root1 = makeTmpDir('pikiclaw-mcp-bridge-');
    const cliPath = path.join(root1, 'src', 'cli', 'main.ts');
    writeFile(cliPath, 'console.log("cli");\n');

    const command1 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: ['--loader', 'tsx', '--inspect=9229'],
      argv: ['node', cliPath],
      moduleUrl: `file://${path.join(root1, 'src', 'agent', 'mcp', 'bridge.ts')}`,
    });

    expect(command1).toEqual({
      command: '/usr/local/bin/node',
      args: ['--loader', 'tsx', cliPath, '--mcp-serve'],
    });

    // --- Compiled session server fallback scenario ---
    const root2 = makeTmpDir('pikiclaw-mcp-bridge-');
    const mcpDir = path.join(root2, 'dist', 'agent', 'mcp');
    const serverPath = path.join(mcpDir, 'session-server.js');
    writeFile(serverPath, 'console.log("server");\n');

    const command2 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: [],
      argv: ['node', path.join(root2, 'other.js')],
      moduleUrl: `file://${path.join(mcpDir, 'bridge.js')}`,
    });

    expect(command2).toEqual({
      command: 'node',
      args: [serverPath],
    });
  });
});

describe('resolveSendFilePath', () => {
  it('prefers workspace-relative files and falls back to workdir-relative files', () => {
    // --- Workspace-relative scenario ---
    const root1 = makeTmpDir('pikiclaw-send-file-');
    const workspacePath1 = path.join(root1, 'workspace');
    const workdir1 = path.join(root1, 'project');
    const workspaceFile = path.join(workspacePath1, 'desktop-screenshot.png');
    const workdirFile1 = path.join(workdir1, 'desktop-screenshot.png');
    writeFile(workspaceFile, 'workspace');
    writeFile(workdirFile1, 'workdir');

    expect(resolveSendFilePath('desktop-screenshot.png', workspacePath1, [], workdir1).path).toBe(workspaceFile);

    // --- Workdir fallback scenario ---
    const root2 = makeTmpDir('pikiclaw-send-file-');
    const workspacePath2 = path.join(root2, 'workspace');
    const workdir2 = path.join(root2, 'project');
    const workdirFile2 = path.join(workdir2, 'desktop-screenshot.png');
    fs.mkdirSync(workspacePath2, { recursive: true });
    writeFile(workdirFile2, 'workdir');

    expect(resolveSendFilePath('desktop-screenshot.png', workspacePath2, [], workdir2).path).toBe(workdirFile2);
  });
});

describe('resolveGuiIntegrationConfig', () => {
  it('resolves managed-profile defaults, env overrides, legacy alias, and remote-CDP implicit enable', () => {
    // --- defaults browser automation to disabled managed-profile mode ---
    expect(resolveGuiIntegrationConfig({} as any, {})).toEqual({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
      peekabooEnabled: false,
    });

    // --- prefers env overrides over user config defaults ---
    expect(resolveGuiIntegrationConfig({ browserEnabled: false } as any, {
      PIKICLAW_BROWSER_ENABLED: 'true',
      PIKICLAW_BROWSER_HEADLESS: 'true',
    })).toEqual({
      browserEnabled: true,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: true,
      peekabooEnabled: false,
    });

    // --- keeps the legacy browser-use-profile env var as a compatibility alias ---
    expect(resolveGuiIntegrationConfig({} as any, {
      PIKICLAW_BROWSER_USE_PROFILE: 'true',
    }).browserEnabled).toBe(true);

    // --- treats a configured remote CDP endpoint as implicitly enabling browser automation ---
    expect(resolveGuiIntegrationConfig({} as any, {
      PIKICLAW_BROWSER_CDP_URL: 'http://chromium:9223',
    }).browserEnabled).toBe(true);

    // --- explicit PIKICLAW_BROWSER_ENABLED=false overrides the remote-CDP implicit enable ---
    expect(resolveGuiIntegrationConfig({} as any, {
      PIKICLAW_BROWSER_CDP_URL: 'http://chromium:9223',
      PIKICLAW_BROWSER_ENABLED: 'false',
    }).browserEnabled).toBe(false);
  });
});

describe('CDP endpoint resolution', () => {
  it('normalizes configured remote URLs and resolves the bridge endpoint without probing local Chrome', async () => {
    // --- getConfiguredRemoteCdpUrl returns the normalized endpoint and strips trailing slashes ---
    expect(getConfiguredRemoteCdpUrl({ PIKICLAW_BROWSER_CDP_URL: 'http://chromium:9223/' })).toBe('http://chromium:9223');
    expect(getConfiguredRemoteCdpUrl({ PIKICLAW_BROWSER_CDP_URL: 'http://chromium:9223' })).toBe('http://chromium:9223');

    // --- getConfiguredRemoteCdpUrl returns null when unset or blank ---
    expect(getConfiguredRemoteCdpUrl({})).toBeNull();
    expect(getConfiguredRemoteCdpUrl({ PIKICLAW_BROWSER_CDP_URL: '   ' })).toBeNull();

    // --- resolveBridgeBrowserEndpoint returns the remote endpoint unconditionally
    // without probing local Chrome. A bogus profile dir would yield no local
    // DevToolsActivePort; the remote override must win and short-circuit any local probe. ---
    expect(await resolveBridgeBrowserEndpoint('/nonexistent/profile/dir', 'http://chromium:9223'))
      .toEqual({ endpoint: 'http://chromium:9223', mode: 'remote' });

    // --- resolveBridgeBrowserEndpoint falls back to none when no remote URL is set
    // and no local Chrome is running ---
    const emptyProfile = makeTmpDir('pikiclaw-no-chrome-');
    expect(await resolveBridgeBrowserEndpoint(emptyProfile, null))
      .toEqual({ endpoint: null, mode: 'none' });
  });
});

describe('buildSupplementalMcpServers & buildGuiSetupHints', () => {
  it('builds Playwright MCP servers and setup hints across disabled / user-data-dir / attach / remote modes', async () => {
    // --- buildSupplementalMcpServers: no Playwright MCP when browser automation is disabled ---
    expect(buildSupplementalMcpServers({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    })).toEqual([]);

    // --- buildSupplementalMcpServers: spawns @playwright/mcp directly in user-data-dir
    // mode when no CDP endpoint is supplied ---
    const managedProfileDir = getManagedBrowserProfileDir();
    const userDataExpected = resolveManagedBrowserMcpCommand(managedProfileDir, { headless: false });
    expect(buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: managedProfileDir,
      browserHeadless: false,
    })).toEqual([
      {
        name: 'pikiclaw-browser',
        command: userDataExpected.command,
        args: userDataExpected.args,
      },
    ]);

    // --- buildSupplementalMcpServers: spawns @playwright/mcp in attach mode when a
    // managed-browser CDP endpoint is supplied ---
    const attachProfileDir = path.join('/tmp', 'pikiclaw', 'browser', 'chrome-profile');
    const attachCdpEndpoint = 'http://127.0.0.1:39222';
    const attachExpected = resolveManagedBrowserMcpCommand(attachProfileDir, { headless: true, cdpEndpoint: attachCdpEndpoint });
    expect(buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: attachProfileDir,
      browserHeadless: true,
    }, {
      cdpEndpoint: attachCdpEndpoint,
    })).toEqual([
      {
        name: 'pikiclaw-browser',
        command: attachExpected.command,
        args: attachExpected.args,
      },
    ]);
    expect(attachExpected.args).toContain('--cdp-endpoint');
    expect(attachExpected.args).toContain(attachCdpEndpoint);

    // --- buildSupplementalMcpServers: attaches to a remote CDP endpoint without ever
    // passing --user-data-dir (no local launch). End-to-end guarantee for issue #16:
    // PIKICLAW_BROWSER_CDP_URL must produce an attach-only playwright/mcp argv, never
    // the user-data-dir launch path that would spawn a local Chrome the container may
    // not even have. ---
    const remote = 'http://chromium:9223';
    const { endpoint, mode } = await resolveBridgeBrowserEndpoint('/tmp/pikiclaw/profile', remote);
    expect(mode).toBe('remote');
    const remoteServers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: '/tmp/pikiclaw/profile',
      browserHeadless: false,
    }, { cdpEndpoint: endpoint });
    const remoteArgs = remoteServers[0]?.args ?? [];
    expect(remoteArgs).toContain('--cdp-endpoint');
    expect(remoteArgs).toContain(remote);
    expect(remoteArgs).not.toContain('--user-data-dir');

    // --- buildGuiSetupHints: no browser hints when browser automation is disabled ---
    expect(buildGuiSetupHints({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    })).toEqual([]);

    // --- buildGuiSetupHints: explains the dedicated managed browser profile mode ---
    const hintProfileDir = path.join('/tmp', 'pikiclaw', 'browser', 'chrome-profile');
    expect(buildGuiSetupHints({
      browserEnabled: true,
      browserProfileDir: hintProfileDir,
      browserHeadless: true,
    })).toEqual([
      `managed browser profile mode enabled; runtime sessions reuse ${hintProfileDir}; configured MCP browser mode=headless. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiclaw will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
    ]);
  });
});

describe('_matchPlaywrightMcpProcessCommand', () => {
  const ENDPOINT = 'http://127.0.0.1:39222';

  it('matches real cli.js / bin-symlink invocations on our endpoint but skips mismatches, inline scripts, and empty inputs', () => {
    // --- matches the direct cli.js invocation that pikiclaw itself spawns ---
    expect(_matchPlaywrightMcpProcessCommand(
      '/opt/homebrew/bin/node /repo/node_modules/@playwright/mcp/cli.js --cdp-endpoint http://127.0.0.1:39222 --output-dir /tmp/out',
      ENDPOINT,
    )).toBe(true);

    // --- matches the npm bin-symlink invocation used by npx / agent CLIs ---
    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/.bin/playwright-mcp --cdp-endpoint http://127.0.0.1:39222',
      ENDPOINT,
    )).toBe(true);

    // --- skips processes attached to a different CDP endpoint ---
    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/@playwright/mcp/cli.js --cdp-endpoint http://127.0.0.1:9999',
      ENDPOINT,
    )).toBe(false);

    // --- skips unrelated node -e scripts whose inline source mentions playwright-mcp ---
    expect(_matchPlaywrightMcpProcessCommand(
      'node -e console.log("@playwright/mcp/cli.js http://127.0.0.1:39222")',
      ENDPOINT,
    )).toBe(false);

    // --- skips bin-symlink processes that do not target our endpoint ---
    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/.bin/playwright-mcp',
      ENDPOINT,
    )).toBe(false);

    // --- returns false when given empty inputs ---
    expect(_matchPlaywrightMcpProcessCommand('', ENDPOINT)).toBe(false);
    expect(_matchPlaywrightMcpProcessCommand('node x.js --cdp-endpoint http://127.0.0.1:39222', '')).toBe(false);
  });
});
