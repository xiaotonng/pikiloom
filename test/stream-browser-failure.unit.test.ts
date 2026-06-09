import { describe, expect, it } from 'vitest';
import { _detectBrowserMcpFailure } from '../src/agent/stream.ts';

describe('_detectBrowserMcpFailure', () => {
  it('detects known failure patterns and ignores benign chunks', () => {
    // flags playwright Frame detached errors
    const frameLine = '{"type":"user","message":{"content":[{"type":"tool_result","content":"### Error\\nError: browserBackend.callTool: Frame has been detached.\\n"}]}}';
    expect(_detectBrowserMcpFailure(frameLine)).toBe('playwright Frame detached');

    // flags pikiclaw-browser MCP stdio close
    const mcpLine = '{"type":"user","message":{"content":[{"type":"tool_result","content":"mcp__pikiclaw-browser__browser_navigate: http://x failed: MCP error -32000: Connection closed"}]}}';
    expect(_detectBrowserMcpFailure(mcpLine)).toBe('pikiclaw-browser MCP stdio closed');

    // does not fire on Connection closed from unrelated MCP servers
    const unrelatedLine = '{"type":"user","message":{"content":[{"type":"tool_result","content":"mcp__atlassian__search failed: MCP error -32000: Connection closed"}]}}';
    expect(_detectBrowserMcpFailure(unrelatedLine)).toBeNull();

    // does not fire on benign stream chunks
    expect(_detectBrowserMcpFailure('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')).toBeNull();
    expect(_detectBrowserMcpFailure('')).toBeNull();
  });
});
