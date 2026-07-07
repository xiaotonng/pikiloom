import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { resolveLoomPaths } from '../src/workspace/paths.js';
import {
  discoverClaudeNativeSessions, discoverCodexNativeSessions, discoverGeminiNativeSessions,
  encodeClaudeProjectDir,
} from '../src/drivers/native.js';
import { SessionsManager } from '../src/workspace/sessions.js';
import { SkillsManager } from '../src/workspace/skills.js';
import { McpRegistry } from '../src/workspace/mcp.js';
import type { AgentDriver, NativeSessionInfo } from '../src/contracts/driver.js';
import type { SessionStore, CoreSessionRecord } from '../src/contracts/ports.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-ws-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('workspace/paths — the top-level directory', () => {
  it('defaults to .pikiloom and resolves global + workspace roots', () => {
    const p = resolveLoomPaths({ home: '/home/u' });
    expect(p.stateDirName).toBe('pikiloom');
    expect(p.dirName).toBe('.pikiloom');
    expect(p.globalRoot).toBe(path.join('/home/u', '.pikiloom'));
    expect(p.workspaceRoot('/work/proj')).toBe(path.join('/work/proj', '.pikiloom'));
    expect(p.sessionsDir('global')).toBe(path.join('/home/u', '.pikiloom', 'sessions'));
    expect(p.skillsDir('workspace', '/work/proj')).toBe(path.join('/work/proj', '.pikiloom', 'skills'));
    expect(p.mcpConfigPath('global')).toBe(path.join('/home/u', '.pikiloom', 'mcp.json'));
    expect(p.agentHome('global')).toBe('/home/u');
    expect(p.agentHome('workspace', '/work/proj')).toBe('/work/proj');
  });

  it('is explicitly configurable (strips a leading dot)', () => {
    expect(resolveLoomPaths({ stateDirName: 'apodex', home: '/h' }).globalRoot).toBe(path.join('/h', '.apodex'));
    expect(resolveLoomPaths({ stateDirName: '.apodex', home: '/h' }).dirName).toBe('.apodex');
  });

  it('createLoom exposes paths (default pikiloom)', () => {
    const loom = createLoom({ drivers: [new EchoDriver()] });
    expect(loom.paths.stateDirName).toBe('pikiloom');
    const custom = createLoom({ drivers: [new EchoDriver()], stateDirName: 'apodex' });
    expect(custom.paths.dirName).toBe('.apodex');
  });
});

describe('workspace/native — discovering an agent\'s own sessions', () => {
  it('encodes a claude project dir like claude does', () => {
    expect(encodeClaudeProjectDir('/Users/x/proj-a')).toBe('-Users-x-proj-a');
  });

  it('discovers claude native sessions from ~/.claude/projects', () => {
    const workdir = path.join(tmp, 'proj');
    const projDir = path.join(tmp, '.claude', 'projects', encodeClaudeProjectDir(workdir));
    fs.mkdirSync(projDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', isMeta: false, message: { content: 'fix the build' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done' }] } }),
    ].join('\n');
    fs.writeFileSync(path.join(projDir, 'sess-abc.jsonl'), lines);

    const out = discoverClaudeNativeSessions(workdir, { home: tmp });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('sess-abc');
    expect(out[0].title).toBe('fix the build');
    expect(out[0].model).toBe('claude-opus-4-8');
    expect(out[0].preview).toBe('done');
  });

  it('discovers codex native sessions filtered by cwd', () => {
    const workdir = path.join(tmp, 'proj');
    fs.mkdirSync(workdir, { recursive: true });
    const sessDir = path.join(tmp, '.codex', 'sessions', '2026', '06');
    fs.mkdirSync(sessDir, { recursive: true });
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'cdx-1', cwd: workdir, timestamp: '2026-06-30T00:00:00Z' } });
    fs.writeFileSync(path.join(sessDir, 'rollout-2026-06-30-cdx-1.jsonl'), meta + '\n');
    // a different cwd → excluded
    const meta2 = JSON.stringify({ type: 'session_meta', payload: { id: 'cdx-2', cwd: '/somewhere/else', timestamp: '2026-06-30T00:00:00Z' } });
    fs.writeFileSync(path.join(sessDir, 'rollout-2026-06-30-cdx-2.jsonl'), meta2 + '\n');
    fs.writeFileSync(path.join(tmp, '.codex', 'session_index.jsonl'),
      JSON.stringify({ id: 'cdx-1', thread_name: 'codex thread', updated_at: '2026-06-30T01:00:00Z' }) + '\n');

    const out = discoverCodexNativeSessions(workdir, { home: tmp });
    expect(out.map(s => s.sessionId)).toEqual(['cdx-1']);
    expect(out[0].title).toBe('codex thread');
    expect(path.resolve(out[0].cwd!)).toBe(path.resolve(workdir));
  });

  it('discovers gemini native sessions via projects.json', () => {
    const workdir = path.join(tmp, 'proj');
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.gemini', 'projects.json'), JSON.stringify({ projects: { [path.resolve(workdir)]: 'projhash' } }));
    const chats = path.join(tmp, '.gemini', 'tmp', 'projhash', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, 'session-1.json'), JSON.stringify({
      sessionId: 'gem-1', startTime: '2026-06-30T00:00:00Z', lastUpdated: '2026-06-30T00:00:00Z',
      messages: [{ type: 'user', content: 'hello gemini' }, { type: 'model', content: 'hi there' }],
    }));

    const out = discoverGeminiNativeSessions(workdir, { home: tmp });
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('gem-1');
    expect(out[0].title).toBe('hello gemini');
    expect(out[0].preview).toBe('hi there');
  });

  it('returns [] when the agent has no store', () => {
    expect(discoverClaudeNativeSessions('/no/such', { home: tmp })).toEqual([]);
    expect(discoverCodexNativeSessions('/no/such', { home: tmp })).toEqual([]);
    expect(discoverGeminiNativeSessions('/no/such', { home: tmp })).toEqual([]);
  });
});

// A tiny in-memory store + a driver that reports native sessions, for SessionsManager tests.
class FakeStore implements SessionStore {
  records: CoreSessionRecord[] = [];
  async ensure() { return { sessionId: 'x', workspacePath: '' }; }
  async get(agent: string, id: string) { return this.records.find(r => r.agent === agent && r.sessionId === id) ?? null; }
  async save() {}
  async list(agent: string) { return this.records.filter(r => r.agent === agent); }
  async recordResult() {}
}
class FakeDriver implements AgentDriver {
  constructor(readonly id: string, private readonly natives: NativeSessionInfo[]) {}
  async run() { return { ok: true, text: '' }; }
  listNativeSessions() { return this.natives; }
}

describe('workspace/sessions — unified managed + native list', () => {
  it('merges, scopes by workspace, dedupes managed-over-native, and searches', async () => {
    const store = new FakeStore();
    store.records = [
      { agent: 'claude', sessionId: 'm1', workspacePath: '', workdir: '/work/a', createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', title: 'managed alpha', preview: 'p1', runState: 'completed' },
      { agent: 'claude', sessionId: 'm2', workspacePath: '', workdir: '/work/b', createdAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-09T00:00:00Z', title: 'managed beta', runState: 'completed' },
      // same id as a native one → managed should win, native should bump updatedAt
      { agent: 'claude', sessionId: 'shared', workspacePath: '', workdir: '/work/a', createdAt: '2026-06-03T00:00:00Z', updatedAt: '2026-06-05T00:00:00Z', title: 'managed shared', runState: 'completed' },
    ];
    const drivers = new Map<string, AgentDriver>([
      ['claude', new FakeDriver('claude', [
        { sessionId: 'n1', title: 'native gamma', preview: 'np', cwd: '/work/a', model: null, createdAt: '2026-06-04T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z', running: true },
        { sessionId: 'shared', title: 'native shared', preview: 'newer', cwd: '/work/a', model: 'claude-x', createdAt: '2026-06-03T00:00:00Z', updatedAt: '2026-06-25T00:00:00Z', running: false },
      ])],
    ]);
    const mgr = new SessionsManager({ store, drivers: () => drivers, defaultWorkdir: '/work/a' });

    const all = await mgr.list({ scope: 'all', workdir: '/work/a' });
    const keys = all.map(s => s.sessionKey);
    expect(keys).toContain('claude:m1');
    expect(keys).toContain('claude:m2');     // global view includes other workdirs
    expect(keys).toContain('claude:n1');     // native-only
    // 'shared' present once, managed identity wins but adopts native's newer updatedAt
    const shared = all.filter(s => s.sessionId === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe('managed');
    expect(shared[0].title).toBe('managed shared');
    expect(shared[0].updatedAt).toBe('2026-06-25T00:00:00Z');
    // sorted newest-first → n1 (06-20) before m1 (06-10)
    expect(keys.indexOf('claude:n1')).toBeLessThan(keys.indexOf('claude:m1'));

    // workspace scope: only managed with matching workdir (m1, shared) + native(/work/a). m2 (/work/b) excluded.
    const ws = await mgr.list({ scope: 'workspace', workdir: '/work/a' });
    expect(ws.map(s => s.sessionId)).not.toContain('m2');
    expect(ws.map(s => s.sessionId)).toContain('m1');

    // includeNative:false drops native-only sessions
    const noNative = await mgr.list({ scope: 'all', workdir: '/work/a', includeNative: false });
    expect(noNative.map(s => s.sessionId)).not.toContain('n1');

    // search by title text
    const found = await mgr.search({ query: 'gamma', workdir: '/work/a' });
    expect(found.map(s => s.sessionId)).toEqual(['n1']);
  });
});

describe('workspace/skills — canonical registry + agent symlinks', () => {
  it('lists skills and symlinks agent dirs to the canonical dir', () => {
    const workdir = path.join(tmp, 'proj');
    const paths = resolveLoomPaths({ stateDirName: 'pikiloom', home: tmp });
    const skills = new SkillsManager({ paths });
    const canonical = skills.canonicalDir('workspace', workdir);
    fs.mkdirSync(path.join(canonical, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(canonical, 'deploy', 'SKILL.md'), '---\nlabel: Deploy\ndescription: ship it\n---\n# Deploy\n');

    const list = skills.list({ workdir, scope: 'workspace' });
    expect(list.map(s => s.name)).toEqual(['deploy']);
    expect(list[0].label).toBe('Deploy');
    expect(list[0].description).toBe('ship it');

    skills.ensureLinks('workspace', workdir);
    const claudeLink = path.join(workdir, '.claude', 'skills');
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    // the skill is visible through the symlink
    expect(fs.existsSync(path.join(claudeLink, 'deploy', 'SKILL.md'))).toBe(true);
  });
});

describe('workspace/mcp — recommended catalog + search', () => {
  it('exposes a recommended catalog and converts to a server spec', () => {
    const reg = new McpRegistry();
    const rec = reg.recommended();
    expect(rec.find(e => e.id === 'filesystem')).toBeTruthy();
    const gh = rec.find(e => e.id === 'github')!;
    const spec = reg.toServerSpec(gh, { GITHUB_PERSONAL_ACCESS_TOKEN: 't' });
    expect(spec).toMatchObject({ name: 'github', type: 'stdio', command: 'npx' });
    expect(spec.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 't' });
  });

  it('searches via an injected fetch (registry shape)', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ servers: [{ name: 'acme-mcp', description: 'a server', packages: [{ identifier: 'acme-mcp' }] }] }),
    })) as unknown as typeof fetch;
    const reg = new McpRegistry({ fetchImpl: fakeFetch });
    const res = await reg.search('acme');
    expect(res).toEqual([{ name: 'acme-mcp', description: 'a server', source: 'registry', npmPackage: 'acme-mcp', homepage: null }]);
  });

  it('returns [] gracefully when both registry and npm fetch fail', async () => {
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const reg = new McpRegistry({ fetchImpl: failing });
    expect(await reg.search('anything')).toEqual([]);
  });
});
