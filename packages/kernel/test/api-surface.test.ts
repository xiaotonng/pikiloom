import { describe, it, expect } from 'vitest';
import * as kernel from '../src/index.js';
import * as drivers from '../src/drivers/index.js';
import * as surfaces from '../src/surfaces/index.js';

// The barrels ARE the public API. This pin makes any widening (a driver-internal helper
// leaking out) or narrowing (a consumer-used symbol dropped) an explicit, reviewed change
// instead of a side effect. Types are erased at runtime, so this covers value exports;
// the .d.ts carries the type surface.

const MAIN = [
  // runtime
  'createLoom', 'Hub', 'SessionRunner', 'runTurn', 'PtyBridge', 'ptyAvailable', 'attachTui',
  // default ports
  'FsSessionStore', 'NullModelResolver', 'NoopToolProvider', 'PassthroughSystemPromptBuilder',
  'AutoCancelInteractionHandler', 'DeferToTerminalInteractionHandler', 'NoopCatalog', 'defaultBaseDir',
  // drivers & surfaces
  'EchoDriver', 'ClaudeDriver', 'CodexDriver', 'GeminiDriver', 'AcpDriver', 'HermesDriver',
  'WebSurface', 'CliSurface',
  // native-session discovery
  'discoverClaudeNativeSessions', 'discoverCodexNativeSessions', 'discoverGeminiNativeSessions',
  'encodeClaudeProjectDir',
  // workspace
  'resolveLoomPaths', 'normalizeStateDirName', 'SessionsManager', 'SkillsManager',
  'ensureDirSymlink', 'parseSkillMeta', 'McpRegistry',
  // accounts
  'accountTokenSupported', 'accountTokenEnvVar', 'accountTokenEnv',
  // protocol
  'PROTOCOL_VERSION', 'emptySnapshot', 'diffSnapshot', 'applySnapshotPatch', 'isClientMessage',
  'makeSessionKey', 'splitSessionKey',
].sort();

const DRIVERS = [
  'EchoDriver', 'ClaudeDriver', 'CodexDriver', 'GeminiDriver', 'AcpDriver', 'HermesDriver',
  'discoverClaudeNativeSessions', 'discoverCodexNativeSessions', 'discoverGeminiNativeSessions',
  'encodeClaudeProjectDir',
].sort();

const SURFACES = ['WebSurface', 'CliSurface'].sort();

describe('public API surface', () => {
  it('main barrel exports exactly the pinned value set', () => {
    expect(Object.keys(kernel).sort()).toEqual(MAIN);
  });
  it('drivers subpath exports exactly the driver classes + native discovery', () => {
    expect(Object.keys(drivers).sort()).toEqual(DRIVERS);
  });
  it('surfaces subpath exports exactly the surface classes', () => {
    expect(Object.keys(surfaces).sort()).toEqual(SURFACES);
  });
});
