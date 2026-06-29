import type { AgentDriver, TuiSpec } from '../contracts/driver.js';
import type { SessionStore, ModelResolver, ToolProvider, SystemPromptBuilder, Catalog, InteractionHandler } from '../contracts/ports.js';
import type { LoomIO, Surface, Plugin } from '../contracts/surface.js';
import {
  FsSessionStore, NullModelResolver, NoopToolProvider, PassthroughSystemPromptBuilder, NoopCatalog,
  DeferToTerminalInteractionHandler, defaultBaseDir,
} from '../ports/defaults.js';
import { Hub } from './hub.js';
import { PtyBridge, type PtyOpenOpts, type PtyExit } from './pty.js';
import { attachTui } from './tui.js';

export interface TuiLaunchOptions {
  agent?: string;
  workdir?: string;
  model?: string | null;
  sessionId?: string | null;
}

export interface LoomConfig {
  appNamespace?: string;          // names ~/.<ns>/sessions for the default store
  workdir?: string;               // default cwd for runs
  defaultAgent?: string;
  drivers?: AgentDriver[];        // the "下层": Claude/Codex/... (explicit; escape hatch = registerDriver)
  surfaces?: Surface[];         // the "上层": IM channels + Web/tunnel, all over LoomIO
  plugins?: Plugin[];
  // side ports — all optional, sane defaults:
  sessionStore?: SessionStore;
  modelResolver?: ModelResolver;
  toolProvider?: ToolProvider;
  systemPromptBuilder?: SystemPromptBuilder;
  catalog?: Catalog;              // discovery of models/effort/tools/skills (app SSOT); default empty
  interactionHandler?: InteractionHandler;  // HITL resolver; default defers to a terminal's interact()
  serialPerSession?: boolean;     // default true: queue concurrent prompts to one session (no clobber)
  systemPromptBase?: string;
  log?: (msg: string) => void;
}

export interface Loom {
  readonly io: LoomIO;
  registerDriver(driver: AgentDriver): void;
  registerPlugin(plugin: Plugin): void;   // dynamic, in addition to LoomConfig.plugins
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { agents: string[]; surfaces: string[]; started: boolean };
  // TUI passthrough:
  resolveTui(opts: TuiLaunchOptions): Promise<TuiSpec>;
  openTui(opts: TuiLaunchOptions & PtyOpenOpts): Promise<PtyBridge>;     // caller drives I/O
  runTui(opts: TuiLaunchOptions & { observers?: Array<(c: string) => void> }): Promise<PtyExit>; // full passthrough on process stdio
}

export function createLoom(config: LoomConfig = {}): Loom {
  const appNamespace = config.appNamespace || 'loom';
  const workdir = config.workdir || process.cwd();
  const log = config.log || (() => {});
  const drivers = new Map<string, AgentDriver>();
  for (const d of config.drivers || []) drivers.set(d.id, d);
  const defaultAgent = config.defaultAgent || config.drivers?.[0]?.id || 'echo';
  // Held as a live reference so registerPlugin() mutates the same array the Hub iterates.
  const plugins: Plugin[] = [...(config.plugins || [])];

  const hub = new Hub({
    drivers,
    defaultAgent,
    workdir,
    sessionStore: config.sessionStore || new FsSessionStore(defaultBaseDir(appNamespace)),
    modelResolver: config.modelResolver || new NullModelResolver(),
    toolProvider: config.toolProvider || new NoopToolProvider(),
    systemPromptBuilder: config.systemPromptBuilder || new PassthroughSystemPromptBuilder(),
    catalog: config.catalog || new NoopCatalog(),
    interactionHandler: config.interactionHandler || new DeferToTerminalInteractionHandler(),
    serialPerSession: config.serialPerSession,
    plugins,
    systemPromptBase: config.systemPromptBase,
    log,
  });

  const surfaces = config.surfaces || [];
  let started = false;

  // Lane R opener (raw PTY): resolve the agent's TUI spec (with model injection) and
  // spawn it in a PtyBridge. Shared by Loom.openTui and the TuiHost given to surfaces.
  const openTui = async (opts: TuiLaunchOptions & PtyOpenOpts): Promise<PtyBridge> => {
    const spec = await hub.resolveTui(opts);
    return PtyBridge.open(spec, { cols: opts.cols, rows: opts.rows });
  };

  return {
    io: hub,
    registerDriver(driver: AgentDriver) { drivers.set(driver.id, driver); },
    registerPlugin(plugin: Plugin) { plugins.push(plugin); },
    async start() {
      if (started) return;
      started = true;
      for (const t of surfaces) {
        await t.start(hub, { openTui });   // hub = Lane S (LoomIO); openTui = Lane R
        log(`[loom] terminal started: ${t.id}`);
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      for (const t of surfaces) { try { await t.stop(); } catch { /* ignore */ } }
    },
    status() {
      return { agents: [...drivers.keys()], surfaces: surfaces.map(t => t.id), started };
    },
    resolveTui(opts: TuiLaunchOptions) { return hub.resolveTui(opts); },
    openTui,
    async runTui(opts) {
      const spec = await hub.resolveTui(opts);
      return attachTui(spec, { observers: opts.observers });
    },
  };
}
