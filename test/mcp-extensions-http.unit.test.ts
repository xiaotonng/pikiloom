import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveUserConfig } from '../src/core/config/user-config.ts';
import { getGlobalExtensionsAsServers } from '../src/agent/mcp/extensions.ts';
import { buildCodexMcpAddArgs, buildGeminiMcpConfig } from '../src/agent/mcp/bridge.ts';
import { withTempHome } from './support/env.ts';

describe('getGlobalExtensionsAsServers — HTTP transport', () => {
  it('emits HTTP entries with OAuth Authorization injected from the token store', async () => {
    await withTempHome(async () => {
      saveUserConfig({
        extensions: {
          mcp: {
            notion: {
              type: 'http',
              url: 'https://mcp.notion.com/mcp',
              enabled: true,
              catalogId: 'notion',
            },
          },
          mcpTokens: {
            notion: {
              accessToken: 'tok-abc',
              tokenType: 'Bearer',
            },
          },
        },
      });

      const servers = getGlobalExtensionsAsServers();
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok-abc' },
      });
    });
  });

  it('emits HTTP entries without Authorization when no token is stored', async () => {
    await withTempHome(async () => {
      saveUserConfig({
        extensions: {
          mcp: {
            generic: {
              type: 'http',
              url: 'https://example.com/mcp',
              enabled: true,
            },
          },
        },
      });

      const [server] = getGlobalExtensionsAsServers();
      expect(server).toMatchObject({ name: 'generic', type: 'http', url: 'https://example.com/mcp' });
      expect(server.headers).toBeUndefined();
    });
  });

  it('skips disabled entries for both stdio and HTTP transports', async () => {
    await withTempHome(async () => {
      saveUserConfig({
        extensions: {
          mcp: {
            'off-http': {
              type: 'http',
              url: 'https://example.com/mcp',
              enabled: false,
            },
            'off-stdio': {
              command: 'noop',
              args: [],
              disabled: true,
            },
            'on-stdio': {
              command: 'echo',
              args: ['hi'],
              enabled: true,
            },
          },
        },
      });

      const names = getGlobalExtensionsAsServers().map(s => s.name).sort();
      expect(names).toEqual(['on-stdio']);
    });
  });

  it('lets a workspace .mcp.json override a global stdio entry with HTTP', async () => {
    await withTempHome(async homeDir => {
      saveUserConfig({
        extensions: {
          mcp: {
            notion: { command: 'should-not-run', args: [] },
          },
        },
      });

      const workdir = path.join(homeDir, 'project');
      fs.mkdirSync(workdir, { recursive: true });
      fs.writeFileSync(
        path.join(workdir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            notion: {
              type: 'http',
              url: 'https://mcp.notion.com/mcp',
              headers: { Authorization: 'Bearer ws-token' },
            },
          },
        }),
      );

      const servers = getGlobalExtensionsAsServers(workdir);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer ws-token' },
      });
    });
  });
});

describe('buildCodexMcpAddArgs', () => {
  it('builds stdio argv with --env flags before the trailing command', () => {
    const args = buildCodexMcpAddArgs(
      {
        name: 'pikiclaw',
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['session-server.js'],
        env: { FOO: 'bar' },
      },
      {},
    );
    expect(args).toEqual(['mcp', 'add', 'pikiclaw', '--env', 'FOO=bar', '--', '/usr/bin/node', 'session-server.js']);
  });

  it('builds HTTP argv with --url and threads the bearer token into tokenEnv', () => {
    const tokenEnv: Record<string, string> = {};
    const args = buildCodexMcpAddArgs(
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok-xyz' },
      },
      tokenEnv,
    );
    expect(args).toEqual([
      'mcp', 'add', 'notion',
      '--url', 'https://mcp.notion.com/mcp',
      '--bearer-token-env-var', 'PIKICLAW_MCP_BEARER_NOTION',
    ]);
    expect(tokenEnv).toEqual({ PIKICLAW_MCP_BEARER_NOTION: 'tok-xyz' });
  });

  it('builds HTTP argv without bearer when no Authorization header is set', () => {
    const tokenEnv: Record<string, string> = {};
    const args = buildCodexMcpAddArgs(
      { name: 'open', type: 'http', url: 'https://example.com/mcp' },
      tokenEnv,
    );
    expect(args).toEqual(['mcp', 'add', 'open', '--url', 'https://example.com/mcp']);
    expect(tokenEnv).toEqual({});
  });

  it('returns null for malformed entries instead of throwing', () => {
    expect(buildCodexMcpAddArgs({ name: 'broken' }, {})).toBeNull();
    expect(buildCodexMcpAddArgs({ name: 'broken-http', type: 'http' }, {})).toBeNull();
  });

  it('sanitizes server name into a valid env-var suffix', () => {
    const tokenEnv: Record<string, string> = {};
    buildCodexMcpAddArgs(
      {
        name: 'my-fancy.server!',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      tokenEnv,
    );
    expect(Object.keys(tokenEnv)).toEqual(['PIKICLAW_MCP_BEARER_MY_FANCY_SERVER']);
  });
});

describe('buildGeminiMcpConfig', () => {
  it('emits {type, url, headers} for HTTP servers and {command, args, env} for stdio', () => {
    const config = buildGeminiMcpConfig([
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok' },
      },
      {
        name: 'pikiclaw',
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['session-server.js'],
        env: { FOO: 'bar' },
      },
    ]);

    expect(config.mcpServers).toEqual({
      notion: {
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok' },
        trust: true,
      },
      pikiclaw: {
        command: '/usr/bin/node',
        args: ['session-server.js'],
        env: { FOO: 'bar' },
        trust: true,
      },
    });
  });

  it('omits headers field for HTTP servers without headers', () => {
    const config = buildGeminiMcpConfig([
      { name: 'open', type: 'http', url: 'https://example.com/mcp' },
    ]);
    expect(config.mcpServers.open).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      trust: true,
    });
  });
});
