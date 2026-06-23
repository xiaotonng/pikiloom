import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveUserConfig } from '../src/core/config/user-config.ts';
import { getGlobalExtensionsAsServers } from '../src/agent/mcp/extensions.ts';
import { buildCodexMcpAddArgs, buildGeminiMcpConfig } from '../src/agent/mcp/bridge.ts';
import { withTempHome } from './support/env.ts';

describe('getGlobalExtensionsAsServers — HTTP transport', () => {
  it('injects OAuth headers, skips disabled entries, and lets workspace .mcp.json override globals', async () => {
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
  it('builds stdio/HTTP argv, threads bearer tokens, sanitizes names, and returns null for malformed entries', () => {
    const stdioArgs = buildCodexMcpAddArgs(
      {
        name: 'pikiloom',
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['session-server.js'],
        env: { FOO: 'bar' },
      },
      {},
    );
    expect(stdioArgs).toEqual(['mcp', 'add', 'pikiloom', '--env', 'FOO=bar', '--', '/usr/bin/node', 'session-server.js']);

    const bearerEnv: Record<string, string> = {};
    const httpArgs = buildCodexMcpAddArgs(
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok-xyz' },
      },
      bearerEnv,
    );
    expect(httpArgs).toEqual([
      'mcp', 'add', 'notion',
      '--url', 'https://mcp.notion.com/mcp',
      '--bearer-token-env-var', 'PIKILOOM_MCP_BEARER_NOTION',
    ]);
    expect(bearerEnv).toEqual({ PIKILOOM_MCP_BEARER_NOTION: 'tok-xyz' });

    const noBearerEnv: Record<string, string> = {};
    const openArgs = buildCodexMcpAddArgs(
      { name: 'open', type: 'http', url: 'https://example.com/mcp' },
      noBearerEnv,
    );
    expect(openArgs).toEqual(['mcp', 'add', 'open', '--url', 'https://example.com/mcp']);
    expect(noBearerEnv).toEqual({});

    expect(buildCodexMcpAddArgs({ name: 'broken' }, {})).toBeNull();
    expect(buildCodexMcpAddArgs({ name: 'broken-http', type: 'http' }, {})).toBeNull();

    const sanitizeEnv: Record<string, string> = {};
    buildCodexMcpAddArgs(
      {
        name: 'my-fancy.server!',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer t' },
      },
      sanitizeEnv,
    );
    expect(Object.keys(sanitizeEnv)).toEqual(['PIKILOOM_MCP_BEARER_MY_FANCY_SERVER']);
  });
});

describe('buildGeminiMcpConfig', () => {
  it('emits HTTP/stdio shapes with trust and omits headers when absent', () => {
    const config = buildGeminiMcpConfig([
      {
        name: 'notion',
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: 'Bearer tok' },
      },
      {
        name: 'pikiloom',
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
      pikiloom: {
        command: '/usr/bin/node',
        args: ['session-server.js'],
        env: { FOO: 'bar' },
        trust: true,
      },
    });

    const openConfig = buildGeminiMcpConfig([
      { name: 'open', type: 'http', url: 'https://example.com/mcp' },
    ]);
    expect(openConfig.mcpServers.open).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      trust: true,
    });
  });
});
