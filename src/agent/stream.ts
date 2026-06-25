import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restartManagedBrowser } from '../browser-supervisor.js';
import { terminateProcessTree } from '../core/process-control.js';
import { AGENT_DETECT_TIMEOUTS, AGENT_STREAM_HARD_KILL_GRACE_MS, AGENT_UPDATE_TIMEOUTS } from '../core/constants.js';
import { awaitAgentUpdateIdle } from './auto-update.js';
import { getDriver, allDrivers, getAcceptedProviderKinds, hasDriver } from './driver.js';
import {
  resolveAgentInjection, getActiveProfile, getActiveProfileId, getProfile, getProvider, updateProfile, listProfiles,
} from '../model/index.js';
import type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  StreamOpts, StreamResult, CodexCumulativeUsage,
  ModelListOpts, ModelListResult, ModelInfo, UsageOpts, UsageResult,
  SessionListOpts, SessionListResult, SessionTailOpts, SessionTailResult,
  SessionMessagesOpts, SessionMessagesResult,
  StreamPreviewMeta, StreamSubAgent, MessageBlock,
} from './types.js';
import {
  Q, agentLog, agentWarn, agentError, joinErrorMessages, normalizeErrorMessage,
  buildStreamPreviewMeta, computeContext, shortValue, isPendingSessionId, dedupeStrings,
  normalizeStreamPreviewPlan,
} from './utils.js';
import {
  saveSessionRecord, setSessionRunState, applySessionRunResult,
  ensureSessionWorkspace, importFilesIntoWorkspace, syncManagedSessionIdentity,
  summarizePromptTitle, recordFork, resolveCanonicalSessionId,
} from './session.js';
import { clearAwaitResume } from './await-resume.js';
import { collapseSkillPrompt } from './skills.js';

function trimSessionText(value: unknown, max = 24_000): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function _detectBrowserMcpFailure(rawLine: string): string | null {
  if (!rawLine) return null;
  if (rawLine.includes('Frame has been detached')) return 'playwright Frame detached';
  if (rawLine.includes('pikiloom-browser') && rawLine.includes('Connection closed')) {
    return 'pikiloom-browser MCP stdio closed';
  }
  return null;
}

const AGENT_DETECT_TTL_MS = AGENT_DETECT_TIMEOUTS.detectTtl;
const AGENT_VERSION_TTL_MS = AGENT_DETECT_TIMEOUTS.versionTtl;
const AGENT_VERSION_TIMEOUT_MS = AGENT_DETECT_TIMEOUTS.versionCommand;

interface AgentDetectCacheEntry {
  detectedAt: number;
  versionAt: number;
  info: AgentInfo;
}

const agentDetectCache = new Map<string, AgentDetectCacheEntry>();

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(cmd: string): string[] {
  if (process.platform !== 'win32') return [cmd];
  const ext = path.extname(cmd).toLowerCase();
  if (ext) return [cmd];
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean);
  return [cmd, ...pathExt.map(value => `${cmd}${value.toLowerCase()}`)];
}

function resolveAgentBinPath(cmd: string): string | null {
  const raw = String(cmd || '').trim();
  if (!raw) return null;

  const hasPathSeparator = raw.includes('/') || raw.includes('\\');
  if (hasPathSeparator) {
    const absolutePath = path.resolve(raw);
    for (const candidate of executableCandidates(absolutePath)) {
      if (isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const searchPaths = String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);

  for (const dir of searchPaths) {
    for (const candidate of executableCandidates(path.join(dir, raw))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function readAgentVersion(binPath: string, timeoutMs: number): string | null {
  try {
    const devnull = process.platform === 'win32' ? '2>nul' : '2>/dev/null';
    return execSync(`${Q(binPath)} --version ${devnull}`, {
      encoding: 'utf-8',
      timeout: Math.max(250, timeoutMs),
    }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

export function detectAgentBin(cmd: string, agent: string, options: AgentDetectOptions = {}): AgentInfo {
  const cacheKey = `${agent}:${cmd}`;
  const now = Date.now();
  const includeVersion = !!options.includeVersion;
  const refresh = !!options.refresh;
  const versionTimeoutMs = options.versionTimeoutMs ?? AGENT_VERSION_TIMEOUT_MS;
  let entry = agentDetectCache.get(cacheKey) || null;

  const shouldRefreshBase = refresh || !entry || now - entry.detectedAt > AGENT_DETECT_TTL_MS;
  if (shouldRefreshBase) {
    const binPath = resolveAgentBinPath(cmd);
    const previousVersion = entry?.info.path === binPath ? entry.info.version ?? null : null;
    const previousVersionAt = entry?.info.path === binPath ? entry.versionAt : 0;
    entry = {
      detectedAt: now,
      versionAt: previousVersionAt,
      info: {
        agent,
        installed: !!binPath,
        path: binPath,
        version: previousVersion,
      },
    };
    agentDetectCache.set(cacheKey, entry);
  }

  if (!entry) {
    return { agent, installed: false, path: null, version: null };
  }

  if (
    includeVersion
    && entry.info.installed
    && entry.info.path
    && (refresh || !entry.versionAt || now - entry.versionAt > AGENT_VERSION_TTL_MS)
  ) {
    entry.info.version = readAgentVersion(entry.info.path, versionTimeoutMs);
    entry.versionAt = now;
    agentDetectCache.set(cacheKey, entry);
  }

  return { ...entry.info };
}

export function listAgents(options: AgentDetectOptions = {}): AgentListResult {
  return { agents: allDrivers().map(d => detectAgentBin(d.cmd, d.id, options)) };
}

export function resolveDefaultAgent(
  preferred: Agent | string | null | undefined,
  agents: AgentInfo[] = listAgents().agents,
): Agent {
  const want = typeof preferred === 'string' ? preferred.trim().toLowerCase() : '';
  const wantValid = !!want && hasDriver(want);
  const installed = agents.filter(a => a.installed).map(a => a.agent);
  if (wantValid && installed.includes(want as Agent)) return want as Agent;
  if (installed.length) return installed[0];
  return wantValid ? (want as Agent) : 'codex';
}

export async function run(
  cmd: string[],
  opts: StreamOpts,
  parseLine: (ev: any, s: any) => void,
  parseStderrLine?: (line: string, s: any) => void,
): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  const byokWindow = opts.byokContextWindow && opts.byokContextWindow > 0
    ? opts.byokContextWindow
    : null;
  const byokProvider = opts.byokProviderName || null;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as unknown[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null,
    turnOutputTokensBase: 0 as number,
    contextWindow: byokWindow as number | null,
    byokContextWindow: byokWindow as number | null,
    byokProviderName: byokProvider as string | null,
    byokProfileName: (opts.byokProfileName || null) as string | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    stopReason: null as string | null, activity: '',
    recentActivity: [] as string[],
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
    geminiToolsById: new Map<string, { name: string; summary: string }>(),
    subAgents: new Map<string, StreamSubAgent>(),
    imageBlocks: [] as MessageBlock[],
    _emitSessionId: opts.onSessionId ?? null,
  };

  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] full command: cd ${Q(opts.workdir)} && ${shellCmd}`);
  agentLog(`[spawn] timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt (stdin): "${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}"`);

  const spawnEnv = { ...process.env, ...(opts.extraEnv || {}) };
  delete spawnEnv.CLAUDECODE;
  const proc = spawn(shellCmd, {
    cwd: opts.workdir,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });
  agentLog(`[spawn] pid=${proc.pid}`);
  proc.stdin?.on('error', (e: any) => {
    if (e?.code !== 'EPIPE') agentWarn(`[stdin] write failed: ${e?.message || e}`);
  });
  const abortStream = () => {
    if (interrupted || proc.killed) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    agentLog(`[abort] user interrupt, killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });
  try { proc.stdin!.write(opts._stdinOverride ?? opts.prompt); proc.stdin!.end(); } catch {}
  let stderrLineBuf = '';
  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
    if (!parseStderrLine) return;
    stderrLineBuf += chunk;
    const lines = stderrLineBuf.split(/\r?\n/);
    stderrLineBuf = lines.pop() || '';
    let touched = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { parseStderrLine(trimmed, s); touched = true; } catch {}
    }
    if (touched) {
      try { opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null); } catch {}
    }
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      agentWarn('[timeout] deadline exceeded, killing process tree');
      terminateProcessTree(proc, { signal: 'SIGKILL' });
      return;
    }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    const browserFailure = _detectBrowserMcpFailure(line);
    if (browserFailure) {
      agentWarn(`[mcp-browser] failure observed (${browserFailure}); requesting browser restart`);
      void restartManagedBrowser(browserFailure);
    }
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      if (evType === 'system' || evType === 'result' || evType === 'assistant' || evType === 'thread.started' || evType === 'turn.completed' || evType === 'item.completed') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || '?'}`);
      }
      parseLine(ev, s);
      opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null);
    } catch {}
  });

  const hardTimer = setTimeout(() => {
    timedOut = true; s.stopReason = 'timeout';
    agentWarn(`[timeout] hard deadline reached (${opts.timeout}s), killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => { clearTimeout(hardTimer); agentLog(`[exit] code=${code} lines_parsed=${lineCount}`); resolve([code === 0, code]); });
    proc.on('error', e => { clearTimeout(hardTimer); agentError(`[error] ${e.message}`); stderr += e.message; resolve([false, -1]); });
  });
  opts.abortSignal?.removeEventListener('abort', abortStream);

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const errorText = joinErrorMessages(s.errors);
  const ok = procOk && !s.errors && !timedOut && !interrupted;
  const error = errorText
    || (interrupted ? 'Interrupted by user.' : null)
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (errorText) agentWarn(`[result] errors: ${errorText}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentWarn(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok, sessionId: s.sessionId, workspacePath: null,
    model: s.model, thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || errorText || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens, contextWindow: s.contextWindow,
    ...computeContext(s), codexCumulative: s.codexCumulative, error, stopReason: s.stopReason,
    incomplete, activity: s.activity.trim() || null,
    assistantBlocks: s.imageBlocks.length ? [...s.imageBlocks] : undefined,
  };
}

function prepareStreamOpts(opts: StreamOpts): { prepared: StreamOpts; session: SessionWorkspaceInfo; attachments: string[]; stagedFiles: string[] } {
  const displayPrompt = collapseSkillPrompt(opts.prompt) ?? opts.prompt;
  const resolvedInboundSessionId = opts.sessionId
    ? resolveCanonicalSessionId(opts.workdir, opts.agent, opts.sessionId)
    : opts.sessionId;
  const session = ensureSessionWorkspace({ agent: opts.agent, workdir: opts.workdir, sessionId: resolvedInboundSessionId, title: displayPrompt });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.attachments || []);
  const attachmentRelPaths = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
  const stagedFiles = [...session.record.stagedFiles];
  session.record.stagedFiles = [];
  session.record.lastUserAttachments = [...attachmentRelPaths];
  if (!session.record.title) session.record.title = summarizePromptTitle(displayPrompt) || null;
  session.record.lastQuestion = shortValue(displayPrompt, 500);
  session.record.lastMessageText = shortValue(displayPrompt, 500);
  setSessionRunState(session.record, 'running', null);
  if (session.sessionId) clearAwaitResume(opts.workdir, opts.agent, session.sessionId);
  saveSessionRecord(opts.workdir, session.record);

  const attachmentPaths = attachmentRelPaths.map(relPath => path.join(session.workspacePath, relPath));

  const effectiveSessionId = isPendingSessionId(session.sessionId) ? null : session.sessionId;

  return {
    session,
    attachments: attachmentPaths,
    stagedFiles,
    prepared: {
      ...opts,
      sessionId: effectiveSessionId,
      attachments: attachmentPaths.length ? attachmentPaths : undefined,
      onSessionId: (nativeSessionId: string) => {
        if (syncManagedSessionIdentity(session, opts.workdir, nativeSessionId)) {
          saveSessionRecord(opts.workdir, session.record);
        }
        try {
          opts.onSessionId?.(nativeSessionId);
        } catch (error: any) {
          agentWarn(`[session] onSessionId callback failed: ${error?.message || error}`);
        }
      },
    },
  };
}

function finalizeStreamResult(result: StreamResult, workdir: string, prompt: string, session: SessionWorkspaceInfo, workflowEnabled?: boolean, profileIdOverride?: string | null): StreamResult {
  if (result.sessionId) syncManagedSessionIdentity(session, workdir, result.sessionId);
  session.record.model = result.model || session.record.model;
  if (result.thinkingEffort) session.record.thinkingEffort = result.thinkingEffort;
  if (workflowEnabled !== undefined) session.record.workflowEnabled = workflowEnabled;
  try {
    session.record.profileId = profileIdOverride !== undefined
      ? (profileIdOverride || null)
      : getActiveProfileId(session.record.agent);
  } catch {
  }
  const displayPrompt = collapseSkillPrompt(prompt) ?? prompt;
  if (!session.record.title) session.record.title = summarizePromptTitle(displayPrompt);
  session.record.lastQuestion = shortValue(displayPrompt, 500);
  session.record.lastAnswer = shortValue(result.message, 500);
  session.record.lastMessageText = shortValue(result.message, 500) || shortValue(displayPrompt, 500);
  session.record.lastThinking = trimSessionText(result.thinking);
  session.record.lastPlan = normalizeStreamPreviewPlan(result.plan);
  applySessionRunResult(session.record, result);
  saveSessionRecord(workdir, session.record);
  return { ...result, sessionId: session.sessionId, workspacePath: session.workspacePath };
}

interface SessionWorkspaceInfo {
  sessionId: string;
  workspacePath: string;
  record: import('./types.js').ManagedSessionRecord;
}

export async function doStream(opts: StreamOpts): Promise<StreamResult> {
  let session: SessionWorkspaceInfo;
  let prepared: StreamOpts;
  let stagedFiles: string[];
  try {
    const prep = prepareStreamOpts(opts);
    session = prep.session;
    prepared = prep.prepared;
    stagedFiles = prep.stagedFiles;
  } catch (e: any) {
    const message = e?.message || String(e);
    return {
      ok: false, message, thinking: null,
      sessionId: opts.sessionId, workspacePath: null, model: opts.model, thinkingEffort: opts.thinkingEffort,
      elapsedS: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null,
      cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null,
      codexCumulative: null, error: message, stopReason: null, incomplete: true, activity: null, plan: null,
    };
  }

  let bridge: import('./mcp/bridge.js').McpBridgeHandle | null = null;
  try {
    const { startMcpBridge, redactMcpConfigForLog } = await import('./mcp/bridge.js');
    const sessionDir = path.dirname(session.workspacePath);
    bridge = await startMcpBridge({
      sessionDir,
      workspacePath: session.workspacePath,
      workdir: opts.workdir,
      stagedFiles,
      sendFile: opts.mcpSendFile,
      onInteraction: opts.onInteraction,
      agent: opts.agent,
      onLog: (message: string) => agentLog(`[mcp] ${message}`),
    });
    if (bridge) {
      prepared.mcpConfigPath = bridge.configPath;
      if (bridge.mcpServers) prepared.mcpServers = bridge.mcpServers;
      if (bridge.extraEnv) prepared.extraEnv = { ...(prepared.extraEnv || {}), ...bridge.extraEnv };
      if (bridge.configPath) agentLog(`[mcp] bridge started on ${bridge.configPath}`);
      else if (bridge.mcpServers) agentLog(`[mcp] bridge registered with ${Object.keys(bridge.mcpServers).length} server(s)`);
      else agentLog('[mcp] bridge registered with codex');
      try { if (bridge.configPath) agentLog(`[mcp] config content:\n${redactMcpConfigForLog(bridge.configPath)}`); } catch {};
    }
  } catch (e: any) {
    agentWarn(`[mcp] bridge start failed: ${e.message} — proceeding without MCP`);
  }

  try {
    const injection = await resolveAgentInjection(prepared.agent, prepared.profileId);
    if (injection) {
      prepared.extraEnv = { ...(prepared.extraEnv || {}), ...injection.env };
      if (injection.modelOverride) {
        if (prepared.agent === 'claude') prepared.claudeModel = injection.modelOverride;
        else if (prepared.agent === 'codex') prepared.codexModel = injection.modelOverride;
        else if (prepared.agent === 'gemini') prepared.geminiModel = injection.modelOverride;
        else if (prepared.agent === 'hermes') prepared.hermesModel = injection.modelOverride;
        prepared.model = injection.modelOverride;
      }
      if (injection.argvAppend?.length) {
        prepared.byokArgvAppend = injection.argvAppend;
      }
      if (injection.codexConfigOverrides?.length) {
        const flags = injection.codexConfigOverrides.flatMap(o => ['-c', o]);
        prepared.codexExtraArgs = [...(prepared.codexExtraArgs || []), ...flags];
      }
      if (injection.contextWindow && injection.contextWindow > 0) {
        prepared.byokContextWindow = injection.contextWindow;
      }
      if (injection.providerName) {
        prepared.byokProviderName = injection.providerName;
      }
      agentLog(`[byok] ${injection.detail}`);
    }
    const activeProfile = prepared.profileId === undefined
      ? getActiveProfile(prepared.agent)
      : (prepared.profileId ? getProfile(prepared.profileId) : null);
    if (activeProfile) {
      if (activeProfile.effort) prepared.thinkingEffort = activeProfile.effort;
      const profileLabel = activeProfile.name?.trim();
      if (profileLabel && profileLabel !== activeProfile.modelId) {
        prepared.byokProfileName = profileLabel;
      }
    }
  } catch (e: any) {
    agentWarn(`[byok] failed to apply Profile injection: ${e?.message || e}`);
  }

  try {
    if (prepared.thinkingEffort) {
      session.record.thinkingEffort = prepared.thinkingEffort.trim().toLowerCase() || session.record.thinkingEffort;
    }
    if (opts.claudeWorkflowEnabled !== undefined) {
      session.record.workflowEnabled = opts.claudeWorkflowEnabled;
    }
    const turnModel = prepared.model
      || (prepared.agent === 'claude' ? prepared.claudeModel
        : prepared.agent === 'codex' ? prepared.codexModel
        : prepared.agent === 'gemini' ? prepared.geminiModel
        : prepared.agent === 'hermes' ? prepared.hermesModel
        : null);
    if (turnModel) session.record.model = turnModel;
    if (prepared.profileId !== undefined) session.record.profileId = prepared.profileId || null;
    saveSessionRecord(opts.workdir, session.record);
  } catch (e: any) {
    agentWarn(`[session] turn-start metadata stamp failed: ${e?.message || e}`);
  }

  try {
    const driver = getDriver(prepared.agent);
    if (opts.forkOf && !driver.capabilities?.fork) {
      throw new Error(`Agent ${prepared.agent} does not support fork`);
    }
    await awaitAgentUpdateIdle(prepared.agent, AGENT_UPDATE_TIMEOUTS.spawnWait);
    const result = await driver.doStream(prepared);
    const finalized = finalizeStreamResult(result, opts.workdir, opts.prompt, session, opts.claudeWorkflowEnabled, opts.profileId);
    finalized.byokProviderName = prepared.byokProviderName ?? null;
    finalized.byokProfileName = prepared.byokProfileName ?? null;
    if (opts.forkOf && finalized.sessionId) {
      try {
        recordFork(opts.workdir, {
          parent: { agent: opts.agent, sessionId: opts.forkOf.parentSessionId },
          child: { agent: opts.agent, sessionId: finalized.sessionId },
          atTurn: opts.forkOf.atTurn,
        });
      } catch (e: any) {
        agentWarn(`[fork] recordFork failed: ${e?.message || e}`);
      }
    }
    return finalized;
  } catch (error: any) {
    const failedResult: StreamResult = {
      ok: false,
      message: normalizeErrorMessage(error) || 'Agent stream failed.',
      thinking: null,
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
      model: session.record.model,
      thinkingEffort: prepared.thinkingEffort,
      elapsedS: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
      codexCumulative: null,
      error: normalizeErrorMessage(error) || 'Agent stream failed.',
      stopReason: null,
      incomplete: true,
      activity: null,
      plan: null,
      byokProviderName: prepared.byokProviderName ?? null,
      byokProfileName: prepared.byokProfileName ?? null,
    };
    const failureDisplayPrompt = collapseSkillPrompt(opts.prompt) ?? opts.prompt;
    session.record.lastQuestion = shortValue(failureDisplayPrompt, 500);
    session.record.lastAnswer = shortValue(failedResult.message, 500);
    session.record.lastMessageText = shortValue(failedResult.message, 500) || shortValue(failureDisplayPrompt, 500);
    session.record.lastThinking = null;
    session.record.lastPlan = null;
    applySessionRunResult(session.record, failedResult);
    saveSessionRecord(opts.workdir, session.record);
    throw error;
  } finally {
    if (bridge) {
      await bridge.stop().catch(() => {});
      if (bridge.hadActivity()) agentLog('[mcp] bridge stopped');
    }
  }
}

export function getSessions(opts: SessionListOpts): Promise<SessionListResult> {
  const workdir = path.resolve(opts.workdir);
  agentLog(`[sessions] request agent=${opts.agent} workdir=${workdir} limit=${opts.limit ?? 'all'}`);
  return getDriver(opts.agent).getSessions(workdir, opts.limit).then(result => {
    agentLog(`[sessions] result agent=${opts.agent} ok=${result.ok} count=${result.sessions.length} error=${result.error || '(none)'}`);
    return result;
  });
}

export function getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  return getDriver(opts.agent).getSessionTail(opts);
}

export function getSessionMessages(opts: SessionMessagesOpts & { agent: Agent }): Promise<SessionMessagesResult> {
  return getDriver(opts.agent).getSessionMessages(opts);
}

export function listModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  return getDriver(agent).listModels(opts);
}

function isLocalProviderBaseURL(baseURL: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(baseURL);
}

export async function resolveAgentModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  const driver = getDriver(agent);

  let nativeResult: ModelListResult;
  try {
    nativeResult = await driver.listModels(opts);
  } catch {
    nativeResult = { agent, models: [], sources: [], note: null };
  }
  const native: ModelInfo[] = nativeResult.models.map(m => ({
    id: m.id,
    alias: m.alias,
    group: 'native',
  }));

  const acceptedKinds = new Set(getAcceptedProviderKinds(agent));
  const cloud: ModelInfo[] = [];
  const local: ModelInfo[] = [];
  if (acceptedKinds.size > 0) {
    for (const profile of listProfiles()) {
      const provider = getProvider(profile.providerId);
      if (!provider) continue;
      if (!acceptedKinds.has(provider.kind)) continue;
      const isLocal = isLocalProviderBaseURL(provider.baseURL);
      const entry: ModelInfo = {
        id: profile.modelId,
        alias: profile.name,
        group: isLocal ? 'local' : 'cloud',
        profileId: profile.id,
        providerName: provider.name,
      };
      (isLocal ? local : cloud).push(entry);
    }
  }

  const sources = [...nativeResult.sources];
  if (cloud.length) sources.push(`${cloud.length} cloud profile${cloud.length === 1 ? '' : 's'}`);
  if (local.length) sources.push(`${local.length} local profile${local.length === 1 ? '' : 's'}`);

  return {
    agent,
    models: [...native, ...cloud, ...local],
    sources,
    note: nativeResult.note ?? null,
  };
}

export function getUsage(opts: UsageOpts): UsageResult {
  return getDriver(opts.agent).getUsage(opts);
}

export function getAgentBoundModelId(agent: Agent): string | null {
  const profile = getActiveProfile(agent);
  return profile?.modelId ?? null;
}

export function setAgentBoundModelId(agent: Agent, modelId: string): boolean {
  const profile = getActiveProfile(agent);
  if (!profile) return false;
  const trimmed = modelId.trim();
  if (!trimmed || trimmed === profile.modelId) return true;
  updateProfile(profile.id, { modelId: trimmed });
  return true;
}
