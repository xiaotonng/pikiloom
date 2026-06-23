import type {
  StreamOpts, StreamResult,
  SessionListResult, SessionTailOpts, SessionTailResult,
  SessionMessagesOpts, SessionMessagesResult,
  ModelListOpts, ModelListResult,
  UsageOpts, UsageResult,
  AgentDriverCapabilities,
} from './index.js';

export interface AgentNativeConfig {
  model: string;
  provider: string;
  baseURL: string | null;
  effort: string | null;
  configPath: string;
  source: string;
}

export interface AgentDriver {
  readonly id: string;
  readonly cmd: string;
  readonly thinkLabel: string;
  readonly capabilities?: AgentDriverCapabilities;
  readonly acceptedProviderKinds?: readonly string[];

  doStream(opts: StreamOpts): Promise<StreamResult>;
  getSessions(workdir: string, limit?: number): Promise<SessionListResult>;
  getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult>;
  getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult>;
  listModels(opts: ModelListOpts): Promise<ModelListResult>;
  getUsage(opts: UsageOpts): UsageResult;
  getUsageLive?(opts: UsageOpts): Promise<UsageResult>;
  getNativeConfig?(): AgentNativeConfig | null;
  deleteNativeSession?(workdir: string, sessionId: string): Promise<string[]>;
  shutdown(): void;
}

const drivers = new Map<string, AgentDriver>();

export function registerDriver(d: AgentDriver) { drivers.set(d.id, d); }

export function getDriver(id: string): AgentDriver {
  const d = drivers.get(id);
  if (!d) throw new Error(`Unknown agent: ${id}. Available: ${[...drivers.keys()].join(', ')}`);
  return d;
}

export function hasDriver(id: string): boolean { return drivers.has(id); }
export function allDrivers(): AgentDriver[] { return [...drivers.values()]; }
export function allDriverIds(): string[] { return [...drivers.keys()]; }

export function shutdownAllDrivers() {
  for (const d of drivers.values()) d.shutdown();
}

const DEFAULT_CAPABILITIES: AgentDriverCapabilities = { fork: false, modelSwitch: true, workflow: false };

export function getDriverCapabilities(id: string): AgentDriverCapabilities {
  const d = drivers.get(id);
  if (!d?.capabilities) return DEFAULT_CAPABILITIES;
  return { ...DEFAULT_CAPABILITIES, ...d.capabilities };
}

export function getAcceptedProviderKinds(id: string): readonly string[] {
  return drivers.get(id)?.acceptedProviderKinds ?? [];
}
