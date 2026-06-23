import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getConfiguredRemoteCdpUrl,
  getManagedBrowserProfileDir,
  resolveManagedBrowserMcpCommand,
} from '../src/browser-profile.ts';
import {
  _matchPeekabooMcpProcessCommand,
  _matchPlaywrightMcpProcessCommand,
  buildPeekabooChildEnv,
  buildGuiSetupHints,
  buildSupplementalMcpServers,
  redactMcpConfigForLog,
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
    const root1 = makeTmpDir('pikiloom-mcp-bridge-');
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

    const root2 = makeTmpDir('pikiloom-mcp-bridge-');
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
    const root1 = makeTmpDir('pikiloom-send-file-');
    const workspacePath1 = path.join(root1, 'workspace');
    const workdir1 = path.join(root1, 'project');
    const workspaceFile = path.join(workspacePath1, 'desktop-screenshot.png');
    const workdirFile1 = path.join(workdir1, 'desktop-screenshot.png');
    writeFile(workspaceFile, 'workspace');
    writeFile(workdirFile1, 'workdir');

    expect(resolveSendFilePath('desktop-screenshot.png', workspacePath1, [], workdir1).path).toBe(workspaceFile);

    const root2 = makeTmpDir('pikiloom-send-file-');
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
    expect(resolveGuiIntegrationConfig({} as any, {})).toEqual({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
      peekabooEnabled: false,
    });

    expect(resolveGuiIntegrationConfig({ browserEnabled: false } as any, {
      PIKILOOM_BROWSER_ENABLED: 'true',
      PIKILOOM_BROWSER_HEADLESS: 'true',
    })).toEqual({
      browserEnabled: true,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: true,
      peekabooEnabled: false,
    });

    expect(resolveGuiIntegrationConfig({} as any, {
      PIKILOOM_BROWSER_USE_PROFILE: 'true',
    }).browserEnabled).toBe(true);

    expect(resolveGuiIntegrationConfig({} as any, {
      PIKILOOM_BROWSER_CDP_URL: 'http://chromium:9223',
    }).browserEnabled).toBe(true);

    expect(resolveGuiIntegrationConfig({} as any, {
      PIKILOOM_BROWSER_CDP_URL: 'http://chromium:9223',
      PIKILOOM_BROWSER_ENABLED: 'false',
    }).browserEnabled).toBe(false);
  });
});

describe('CDP endpoint resolution', () => {
  it('normalizes configured remote URLs and resolves the bridge endpoint without probing local Chrome', async () => {
    expect(getConfiguredRemoteCdpUrl({ PIKILOOM_BROWSER_CDP_URL: 'http://chromium:9223/' })).toBe('http://chromium:9223');
    expect(getConfiguredRemoteCdpUrl({ PIKILOOM_BROWSER_CDP_URL: 'http://chromium:9223' })).toBe('http://chromium:9223');

    expect(getConfiguredRemoteCdpUrl({})).toBeNull();
    expect(getConfiguredRemoteCdpUrl({ PIKILOOM_BROWSER_CDP_URL: '   ' })).toBeNull();

    expect(await resolveBridgeBrowserEndpoint('/nonexistent/profile/dir', 'http://chromium:9223'))
      .toEqual({ endpoint: 'http://chromium:9223', mode: 'remote' });

    const emptyProfile = makeTmpDir('pikiloom-no-chrome-');
    expect(await resolveBridgeBrowserEndpoint(emptyProfile, null))
      .toEqual({ endpoint: null, mode: 'none' });
  });
});

describe('buildSupplementalMcpServers & buildGuiSetupHints', () => {
  it('builds Playwright MCP servers and setup hints across disabled / user-data-dir / attach / remote modes', async () => {
    expect(buildSupplementalMcpServers({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    })).toEqual([]);

    const managedProfileDir = getManagedBrowserProfileDir();
    const userDataExpected = resolveManagedBrowserMcpCommand(managedProfileDir, { headless: false });
    expect(buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: managedProfileDir,
      browserHeadless: false,
    })).toEqual([
      {
        name: 'pikiloom-browser',
        command: userDataExpected.command,
        args: userDataExpected.args,
      },
    ]);

    const attachProfileDir = path.join('/tmp', 'pikiloom', 'browser', 'chrome-profile');
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
        name: 'pikiloom-browser',
        command: attachExpected.command,
        args: attachExpected.args,
      },
    ]);
    expect(attachExpected.args).toContain('--cdp-endpoint');
    expect(attachExpected.args).toContain(attachCdpEndpoint);

    const remote = 'http://chromium:9223';
    const { endpoint, mode } = await resolveBridgeBrowserEndpoint('/tmp/pikiloom/profile', remote);
    expect(mode).toBe('remote');
    const remoteServers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: '/tmp/pikiloom/profile',
      browserHeadless: false,
    }, { cdpEndpoint: endpoint });
    const remoteArgs = remoteServers[0]?.args ?? [];
    expect(remoteArgs).toContain('--cdp-endpoint');
    expect(remoteArgs).toContain(remote);
    expect(remoteArgs).not.toContain('--user-data-dir');

    expect(buildGuiSetupHints({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    })).toEqual([]);

    const hintProfileDir = path.join('/tmp', 'pikiloom', 'browser', 'chrome-profile');
    expect(buildGuiSetupHints({
      browserEnabled: true,
      browserProfileDir: hintProfileDir,
      browserHeadless: true,
    })).toEqual([
      `managed browser profile mode enabled; runtime sessions reuse ${hintProfileDir}; configured MCP browser mode=headless. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiloom will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
    ]);
  });

  it('runs Peekaboo through an env-isolated npx command with only safe shell variables', () => {
    const env = buildPeekabooChildEnv({
      HOME: '/Users/tester',
      PATH: '/opt/homebrew/bin:/usr/bin',
      USER: 'tester',
      OPENAI_API_KEY: 'sk-should-not-leak',
      ANTHROPIC_API_KEY: 'ak-should-not-leak',
      PIKILOOM_CHANNEL: 'telegram',
      LANG: 'en_US.UTF-8',
    });
    expect(env).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/opt/homebrew/bin:/usr/bin',
      USER: 'tester',
      LANG: 'en_US.UTF-8',
      PIKILOOM_MCP_SERVER: 'peekaboo',
      npm_config_yes: 'true',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PIKILOOM_CHANNEL).toBeUndefined();

    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const [server] = buildSupplementalMcpServers({
        browserEnabled: false,
        browserProfileDir: getManagedBrowserProfileDir(),
        browserHeadless: false,
        peekabooEnabled: true,
      });
      expect(server.name).toBe('peekaboo');
      expect(server.command).toBe('/usr/bin/env');
      expect(server.args).toContain('-i');
      expect(server.args).toContain('npx');
      expect(server.args).toContain('@steipete/peekaboo');
      expect(server.args).toContain('peekaboo-mcp');
      expect(server.args?.some(arg => arg.startsWith('OPENAI_API_KEY='))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});

describe('_matchPlaywrightMcpProcessCommand', () => {
  const ENDPOINT = 'http://127.0.0.1:39222';

  it('matches real cli.js / bin-symlink invocations on our endpoint but skips mismatches, inline scripts, and empty inputs', () => {
    expect(_matchPlaywrightMcpProcessCommand(
      '/opt/homebrew/bin/node /repo/node_modules/@playwright/mcp/cli.js --cdp-endpoint http://127.0.0.1:39222 --output-dir /tmp/out',
      ENDPOINT,
    )).toBe(true);

    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/.bin/playwright-mcp --cdp-endpoint http://127.0.0.1:39222',
      ENDPOINT,
    )).toBe(true);

    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/@playwright/mcp/cli.js --cdp-endpoint http://127.0.0.1:9999',
      ENDPOINT,
    )).toBe(false);

    expect(_matchPlaywrightMcpProcessCommand(
      'node -e console.log("@playwright/mcp/cli.js http://127.0.0.1:39222")',
      ENDPOINT,
    )).toBe(false);

    expect(_matchPlaywrightMcpProcessCommand(
      'node /repo/node_modules/.bin/playwright-mcp',
      ENDPOINT,
    )).toBe(false);

    expect(_matchPlaywrightMcpProcessCommand('', ENDPOINT)).toBe(false);
    expect(_matchPlaywrightMcpProcessCommand('node x.js --cdp-endpoint http://127.0.0.1:39222', '')).toBe(false);
  });
});

describe('_matchPeekabooMcpProcessCommand', () => {
  it('matches real peekaboo-mcp launch forms and skips warm/search/eval commands', () => {
    expect(_matchPeekabooMcpProcessCommand(
      '/usr/bin/env -i HOME=/Users/test PATH=/usr/bin npx -y -p @steipete/peekaboo peekaboo-mcp',
    )).toBe(true);
    expect(_matchPeekabooMcpProcessCommand(
      '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js exec @steipete/peekaboo peekaboo-mcp',
    )).toBe(true);
    expect(_matchPeekabooMcpProcessCommand(
      '/Users/test/.npm/_npx/abc/node_modules/.bin/peekaboo-mcp',
    )).toBe(true);

    expect(_matchPeekabooMcpProcessCommand(
      'npx -y -p @steipete/peekaboo peekaboo --version',
    )).toBe(false);
    expect(_matchPeekabooMcpProcessCommand('rg peekaboo-mcp')).toBe(false);
    expect(_matchPeekabooMcpProcessCommand('node -e console.log("peekaboo-mcp")')).toBe(false);
    expect(_matchPeekabooMcpProcessCommand('')).toBe(false);
  });
});

describe('redactMcpConfigForLog', () => {
  it('redacts MCP credentials before config content is logged', () => {
    const root = makeTmpDir('pikiloom-redact-mcp-');
    const configPath = path.join(root, 'mcp-config.json');
    writeFile(configPath, JSON.stringify({
      mcpServers: {
        notion: {
          type: 'http',
          url: 'https://mcp.notion.com/mcp?access_token=url-token',
          headers: { Authorization: 'Bearer oauth-token' },
        },
        postgres: {
          command: 'npx',
          args: ['postgresql://user:db-pass@localhost:5432/app'],
          env: { OPENAI_API_KEY: 'sk-secret', SAFE_FLAG: 'ok' },
        },
      },
    }, null, 2));

    const logged = redactMcpConfigForLog(configPath);
    expect(logged).toContain('Bearer [REDACTED]');
    expect(logged).toContain('OPENAI_API_KEY');
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('SAFE_FLAG');
    expect(logged).toContain('ok');
    expect(logged).not.toContain('oauth-token');
    expect(logged).not.toContain('url-token');
    expect(logged).not.toContain('db-pass');
    expect(logged).not.toContain('sk-secret');
  });
});
