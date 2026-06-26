import path from 'node:path';
import fs from 'node:fs';
import type { Bot, ChatId, Agent, SessionInfo, SessionRuntime, ChatState, StreamResult } from './bot.js';
import { fmtTokens, fmtUptime, fmtBytes } from './bot.js';
import {
  getProjectSkillPaths, normalizeClaudeModelId, sessionListDisplayTitle,
  listAllMcpExtensions, listSkills as listAllSkills,
} from '../agent/index.js';
import { getDriver } from '../agent/driver.js';
import { effortOptionsFor } from '../core/config/runtime-config.js';
import { getActiveProfile, getProvider } from '../model/index.js';
import { buildWelcomeIntro, buildSkillCommandName, indexSkillsByCommand, SKILL_CMD_PREFIX } from './menu.js';
import { buildBotMenuState } from './orchestration.js';
import { summarizePromptForStatus } from './streaming.js';
import { getSessionStatusForChat } from './session-status.js';
import { loadWorkspaces } from '../core/config/user-config.js';
import { VERSION } from '../core/version.js';
import { readGitStatus, type GitStatus } from '../core/git.js';

export interface AgentDetail {
  agent: Agent;
  model: string;
  effort: string | null;
}

export interface StartData {
  title: string;
  subtitle: string;
  version: string;
  agent: Agent;
  workdir: string;
  agentDetails: AgentDetail[];
  commands: Array<{ command: string; description: string }>;
}

export function getStartData(bot: Bot, chatId: ChatId): StartData {
  const cs = bot.chat(chatId);
  const intro = buildWelcomeIntro(VERSION);
  const commands = buildBotMenuState(bot).commands;
  const res = bot.fetchAgents();
  const agentDetails: AgentDetail[] = res.agents
    .filter(a => a.installed)
    .map(a => ({
      agent: a.agent,
      model: bot.modelForAgent(a.agent) || '(default)',
      effort: bot.effortSelectionForAgent(a.agent),
    }));
  return {
    ...intro,
    agent: cs.agent,
    workdir: bot.chatWorkdir(chatId),
    agentDetails,
    commands,
  };
}

export interface WorkspaceQuickPick {
  path: string;
  name: string;
  isCurrent: boolean;
  exists: boolean;
}

export interface WorkspacesData {
  currentWorkdir: string;
  workspaces: WorkspaceQuickPick[];
}

export function getWorkspacesData(bot: Bot, chatId: ChatId): WorkspacesData {
  const currentWorkdir = path.resolve(bot.chatWorkdir(chatId));
  const entries = loadWorkspaces();
  const workspaces = entries
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map<WorkspaceQuickPick>(w => {
      const resolved = path.resolve(w.path);
      let exists = false;
      try { exists = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory(); } catch { exists = false; }
      return {
        path: resolved,
        name: w.name || path.basename(resolved),
        isCurrent: resolved === currentWorkdir,
        exists,
      };
    });
  return { currentWorkdir, workspaces };
}

export async function handleGoalCommand(bot: Bot, chatId: ChatId, rawArgs: string): Promise<string | null> {
  const session = bot.selectedSession(chatId);
  if (!session || !session.sessionId) return null;
  const args = rawArgs.trim();
  const workdir = session.workdir;
  const agent = session.agent;
  const sessionId = session.sessionId;

  if (!args) {
    const goal = await bot.getSessionGoal(workdir, agent, sessionId);
    return formatGoalStatusLine(goal, agent);
  }

  const lower = args.toLowerCase();
  try {
    if (lower === 'pause') {
      const goal = await bot.pauseSessionGoal(workdir, agent, sessionId);
      if (!goal) return 'No goal set for this session.';
      return `Paused goal: ${truncate(goal.objective, 80)}`;
    }
    if (lower === 'resume') {
      const goal = await bot.resumeSessionGoal(workdir, agent, sessionId, { chatId });
      if (!goal) return 'No goal to resume.';
      if (goal.status !== 'active') return `Cannot resume goal (status: ${goal.status}).`;
      return `Resumed goal: ${truncate(goal.objective, 80)}`;
    }
    if (lower === 'clear' || lower === 'cancel' || lower === 'stop') {
      await bot.clearSessionGoal(workdir, agent, sessionId, { chatId });
      return agent === 'claude'
        ? 'Submitted `/goal clear` to claude. (Native /goal auto-clears once the condition is met, so this is only needed to stop early.)'
        : 'Cleared goal.';
    }

    const { objective, tokenBudget } = parseObjective(args);
    if (!objective) return 'Usage: /goal <objective>  (or pause / resume / clear)';
    if (agent === 'claude' && tokenBudget != null) {
      return 'Claude native /goal does not support `budget=N` — drop the budget prefix. (Use a codex session if you need a token budget.)';
    }
    const goal = await bot.setSessionGoal(workdir, agent, sessionId, {
      objective,
      tokenBudget,
      chatId,
    });
    const budgetLabel = goal.tokenBudget != null ? `, budget ${goal.tokenBudget} tokens` : '';
    if (agent === 'codex') {
      return [
        `Goal set (codex native)${budgetLabel}: ${truncate(goal.objective, 120)}`,
        'Send any message to trigger codex\'s native continuation loop. Each message resumes the thread and codex audits / continues until it marks the goal complete or hits the budget.',
      ].join('\n');
    }
    if (agent === 'claude') {
      return [
        `Goal set (claude native): ${truncate(goal.objective, 120)}`,
        'Claude\'s in-process Stop hook keeps working until a Haiku judge confirms the condition is met, then auto-clears. Send `/goal clear` to stop early; `/goal` to inspect.',
      ].join('\n');
    }
    return `Goal set${budgetLabel}: ${truncate(goal.objective, 120)}\nThe agent will keep working until it audits the objective complete${goal.tokenBudget != null ? ' or exhausts the budget' : ''}.`;
  } catch (e: any) {
    return `Failed: ${e?.message || e}`;
  }
}

function formatGoalStatusLine(goal: Awaited<ReturnType<Bot['getSessionGoal']>>, agent: Agent): string {
  if (!goal) return 'No goal set for this session. Use `/goal <objective>` to set one.';
  if (goal.source === 'claude') {
    return [
      `Goal: ${truncate(goal.objective, 200)}`,
      `Status: ${goal.status}  ·  claude native (Stop hook, auto-clears on completion)`,
    ].join('\n');
  }
  const budget = goal.tokenBudget != null
    ? `${goal.tokensUsed}/${goal.tokenBudget} tokens`
    : `${goal.tokensUsed} tokens (no budget)`;
  const continuations = goal.continuationCount != null ? `  ·  ${goal.continuationCount} continuations` : '';
  const engine = goal.source === 'codex' ? '  ·  codex native' : '';
  return [
    `Goal: ${truncate(goal.objective, 200)}`,
    `Status: ${goal.status}  ·  ${budget}${continuations}  ·  ${goal.timeUsedSeconds}s elapsed${engine}`,
  ].join('\n');
}

function parseObjective(args: string): { objective: string; tokenBudget: number | null } {
  const m = args.match(/^budget=(\d+)\s+(.+)$/i);
  if (m) {
    const tokenBudget = Number.parseInt(m[1], 10);
    return { objective: m[2].trim(), tokenBudget: Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : null };
  }
  return { objective: args, tokenBudget: null };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface SessionEntry {
  key: string;
  agent: Agent;
  title: string;
  time: string;
  isCurrent: boolean;
  isRunning: boolean;
  runState: 'running' | 'completed' | 'incomplete';
  runDetail: string | null;
}

export interface SessionsPageData {
  workspaceName: string;
  agentTotals: Record<string, number>;
  total: number;
  page: number;
  totalPages: number;
  sessions: SessionEntry[];
}

export interface SessionDigestEntry {
  index: number;
  agent: Agent;
  title: string;
  time: string;
  runState: SessionEntry['runState'];
  runDetail: string | null;
  isCurrent: boolean;
  sessionKey: string;
}

export interface SessionsDigestData {
  workspaceName: string;
  agentTotals: Record<string, number>;
  total: number;
  entries: SessionDigestEntry[];
}

export interface SessionTurnPreviewData {
  userText: string | null;
  assistantText: string | null;
}

export interface SessionRunSummary {
  state: 'running' | 'completed' | 'incomplete';
  shortLabel: string;
  noticeDetail: string;
}

export function summarizeSessionRun(session: Pick<SessionInfo, 'running' | 'runState' | 'runDetail'>): SessionRunSummary {
  if (session.running || session.runState === 'running') {
    return {
      state: 'running',
      shortLabel: 'running',
      noticeDetail: 'Status: running',
    };
  }
  if (session.runState === 'incomplete') {
    const detail = String(session.runDetail || '').trim();
    return {
      state: 'incomplete',
      shortLabel: 'unfinished',
      noticeDetail: detail ? `Status: unfinished · ${detail}` : 'Status: unfinished',
    };
  }
  return {
    state: 'completed',
    shortLabel: 'done',
    noticeDetail: 'Status: completed',
  };
}

export async function getSessionsPageData(bot: Bot, chatId: ChatId, page: number, pageSize = 5): Promise<SessionsPageData> {
  const cs = bot.chat(chatId);
  const res = await bot.fetchSessions(undefined, bot.chatWorkdir(chatId));
  const sessions = res.ok ? res.sessions : [];
  const total = sessions.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pg = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sessions.slice(pg * pageSize, (pg + 1) * pageSize);

  const agentTotals: Record<string, number> = {};
  for (const s of sessions) agentTotals[s.agent] = (agentTotals[s.agent] || 0) + 1;

  const entries: SessionEntry[] = [];
  for (const s of slice) {
    const sessionKey = s.sessionId || '';
    if (!sessionKey) continue;
    const status = getSessionStatusForChat(bot, cs, s);
    const runSummary = summarizeSessionRun({
      running: status.isRunning,
      runState: status.isRunning ? 'running' : s.runState,
      runDetail: s.runDetail,
    });
    const displayText = sessionListDisplayTitle(s);
    const title = displayText ? displayText.replace(/\n/g, ' ').slice(0, 28) : sessionKey.slice(0, 28);
    const time = s.createdAt
      ? new Date(s.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '?';
    entries.push({
      key: sessionKey,
      agent: s.agent,
      title,
      time: `${time} · ${runSummary.shortLabel}`,
      isCurrent: status.isCurrent,
      isRunning: status.isRunning,
      runState: runSummary.state,
      runDetail: s.runDetail,
    });
  }

  return {
    workspaceName: res.workspaceName || '',
    agentTotals,
    total,
    page: pg,
    totalPages,
    sessions: entries,
  };
}

export async function getSessionsDigestData(
  bot: Bot,
  chatId: ChatId,
  limit = 8,
): Promise<SessionsDigestData> {
  const pageData = await getSessionsPageData(bot, chatId, 0, Math.max(1, limit));
  const entries: SessionDigestEntry[] = pageData.sessions.map((session, index) => ({
    index: index + 1,
    agent: session.agent,
    title: session.title,
    time: session.time,
    runState: session.runState,
    runDetail: session.runDetail,
    isCurrent: session.isCurrent,
    sessionKey: session.key,
  }));
  return {
    workspaceName: pageData.workspaceName,
    agentTotals: pageData.agentTotals,
    total: pageData.total,
    entries,
  };
}

export function formatSessionsDigestText(data: SessionsDigestData): string {
  if (!data.entries.length) {
    return data.workspaceName
      ? `No sessions in ${data.workspaceName} yet. Send a message to start.`
      : 'No sessions yet. Send a message to start.';
  }

  const agentBits = Object.entries(data.agentTotals)
    .map(([agent, count]) => `${agent}×${count}`)
    .join(' · ');
  const lines = [
    `Session digest — ${data.workspaceName || 'workspace'} (${data.total} total${agentBits ? ` · ${agentBits}` : ''})`,
    '',
  ];

  for (const entry of data.entries) {
    const flags = [
      entry.isCurrent ? 'current' : null,
      entry.runState === 'running' ? 'running' : null,
      entry.runState === 'incomplete' ? 'unfinished' : null,
    ].filter(Boolean).join(', ');
    const flagSuffix = flags ? ` [${flags}]` : '';
    lines.push(`${entry.index}. ${entry.agent} · ${entry.title}${flagSuffix}`);
    const detail = entry.runDetail ? ` · ${entry.runDetail}` : '';
    lines.push(`   ${entry.time}${detail}`);
  }

  lines.push('', 'Switch: /sessions <#>  ·  Browse: /sessions');
  return lines.join('\n');
}

export function extractLastSessionTurn(
  messages: Array<{ role: 'user' | 'assistant'; text: string }>,
): SessionTurnPreviewData | null {
  if (!messages.length) return null;

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const userText = String(lastUserIndex >= 0 ? messages[lastUserIndex].text : '').trim() || null;
  const assistantTexts: string[] = [];
  for (let i = lastUserIndex >= 0 ? lastUserIndex + 1 : 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i].text) assistantTexts.push(messages[i].text);
  }
  const assistantText = assistantTexts.join('\n\n').trim() || null;

  if (!userText && !assistantText) return null;
  return { userText, assistantText };
}

export async function getSessionTurnPreviewData(
  bot: Bot,
  agent: Agent,
  sessionId: string | null,
  limit = 50,
  workdir?: string,
): Promise<SessionTurnPreviewData | null> {
  if (!sessionId) return null;
  const tail = await bot.fetchSessionTail(agent, sessionId, limit, workdir);
  if (!tail.ok || !tail.messages.length) return null;
  return extractLastSessionTurn(tail.messages);
}

export interface AgentEntry {
  agent: string;
  label: string;
  installed: boolean;
  version: string | null;
  versionShort: string | null;
  path: string | null;
  isCurrent: boolean;
  boundProvider: string | null;
  boundModel: string | null;
}

export interface AgentsListData {
  currentAgent: Agent;
  agents: AgentEntry[];
}

const AGENT_LABEL_OVERRIDES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  hermes: 'Hermes',
};

function agentDisplayLabel(agentId: string): string {
  return AGENT_LABEL_OVERRIDES[agentId]
    || agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

function shortVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return m ? m[0] : raw.trim();
}

export function getAgentsListData(bot: Bot, chatId: ChatId): AgentsListData {
  const cs = bot.chat(chatId);
  const res = bot.fetchAgents();
  return {
    currentAgent: cs.agent,
    agents: res.agents.map(a => {
      const profile = getActiveProfile(a.agent);
      const provider = profile ? getProvider(profile.providerId) : null;
      return {
        agent: a.agent,
        label: agentDisplayLabel(a.agent),
        installed: a.installed,
        version: a.version ?? null,
        versionShort: shortVersion(a.version ?? null),
        path: a.path ?? null,
        isCurrent: a.agent === cs.agent,
        boundProvider: provider?.name ?? null,
        boundModel: profile?.modelId ?? null,
      };
    }),
  };
}

export interface SkillEntryData {
  name: string;
  label: string;
  description: string | null;
  command: string;
  source: 'skills';
}

export interface SkillsListData {
  agent: Agent;
  workdir: string;
  skills: SkillEntryData[];
}

export function getSkillsListData(bot: Bot, chatId: ChatId): SkillsListData {
  const cs = bot.chat(chatId);
  const skills = bot.fetchSkills(bot.chatWorkdir(chatId)).skills
    .map(skill => {
      const command = buildSkillCommandName(skill.name);
      if (!command) return null;
      return {
        name: skill.name,
        label: skill.label || skill.name.charAt(0).toUpperCase() + skill.name.slice(1),
        description: skill.description,
        command,
        source: skill.source,
      };
    })
    .filter((skill): skill is SkillEntryData => !!skill);
  return { agent: cs.agent, workdir: bot.chatWorkdir(chatId), skills };
}

export interface ModelEntry {
  id: string;
  alias: string | null;
  isCurrent: boolean;
  group?: 'native' | 'cloud' | 'local';
  profileId?: string | null;
  providerName?: string | null;
}

export interface EffortEntry {
  id: string;
  label: string;
  isCurrent: boolean;
}

export interface ModelsListData {
  agent: Agent;
  currentModel: string;
  sources: string[];
  note: string | null;
  models: ModelEntry[];
  effort: { current: string; levels: EffortEntry[] } | null;
}

function claudeModelFamily(modelId: string | null | undefined): string | null {
  const value = normalizeClaudeModelId(modelId).toLowerCase();
  if (!value) return null;
  if (value === 'fable' || value.startsWith('claude-fable-')) return 'fable';
  if (value === 'opus' || value.startsWith('claude-opus-')) return 'opus';
  if (value === 'sonnet' || value.startsWith('claude-sonnet-')) return 'sonnet';
  if (value === 'haiku' || value.startsWith('claude-haiku-')) return 'haiku';
  return null;
}

function isClaudeFamilyAlias(modelId: string): boolean {
  const v = modelId.trim().toLowerCase();
  return v === 'fable' || v === 'opus' || v === 'sonnet' || v === 'haiku';
}

export function modelMatchesSelection(agent: Agent, selection: string, currentModel: string): boolean {
  if (selection === currentModel) return true;
  if (agent !== 'claude') return false;
  if (!isClaudeFamilyAlias(selection) && !isClaudeFamilyAlias(currentModel)) return false;
  const a = claudeModelFamily(selection);
  const b = claudeModelFamily(currentModel);
  return !!a && a === b;
}

function buildEffortData(bot: Bot, agent: Agent, model: string): ModelsListData['effort'] {
  const currentEffort = bot.effortSelectionForAgent(agent);
  if (!currentEffort) return null;
  const levels = effortOptionsFor(agent, model);
  if (!levels.length) return null;
  return {
    current: currentEffort,
    levels: levels.map(l => ({ ...l, isCurrent: l.id === currentEffort })),
  };
}

export async function getModelsListData(bot: Bot, chatId: ChatId): Promise<ModelsListData> {
  const cs = bot.chat(chatId);
  const currentModel = bot.modelForAgent(cs.agent);
  const activeProfileId = bot.activeProfileIdForAgent(cs.agent);
  const res = await bot.fetchModels(cs.agent, bot.chatWorkdir(chatId));
  return {
    agent: cs.agent,
    currentModel,
    sources: res.sources,
    note: res.note ?? null,
    models: res.models.map(m => {
      const group = m.group ?? 'native';
      const isProfileRow = group !== 'native';
      const isCurrent = activeProfileId
        ? !!m.profileId && m.profileId === activeProfileId
        : !isProfileRow && modelMatchesSelection(cs.agent, m.id, currentModel);
      return {
        id: m.id,
        alias: m.alias ?? null,
        isCurrent,
        group,
        profileId: m.profileId ?? null,
        providerName: m.providerName ?? null,
      };
    }),
    effort: buildEffortData(bot, cs.agent, currentModel),
  };
}

export interface StatusData {
  version: string;
  uptime: number;
  memRss: number;
  memHeap: number;
  pid: number;
  workdir: string;
  agent: Agent;
  model: string;
  sessionId: string | null;
  workspacePath: string | null;
  activeTasksCount: number;
  running: { prompt: string; startedAt: number } | null;
  stats: { totalTurns: number; totalInputTokens: number; totalOutputTokens: number; totalCachedTokens: number };
  usage: any;
  git: GitStatus | null;
}

export async function getStatusDataAsync(bot: Bot, chatId: ChatId): Promise<StatusData> {
  const d = bot.getStatusData(chatId);
  const driver = getDriver(d.agent);
  const usage = driver.getUsageLive
    ? await driver.getUsageLive({ agent: d.agent, model: d.model }).catch(() => d.usage)
    : d.usage;
  return {
    ...d,
    running: d.running ? { prompt: d.running.prompt, startedAt: d.running.startedAt } : null,
    usage,
    git: readGitStatus(d.workdir),
  };
}

export type HostData = ReturnType<Bot['getHostData']>;

export function getHostDataSync(bot: Bot): HostData {
  return bot.getHostData();
}

export { SKILL_CMD_PREFIX, indexSkillsByCommand };

function relSkillPath(workdir: string, filePath: string): string {
  const relative = path.relative(workdir, filePath).replace(/\\/g, '/');
  return relative && !relative.startsWith('..') ? relative : filePath;
}

export function resolveSkillPrompt(bot: Bot, chatId: ChatId, cmd: string, args: string): { prompt: string; skillName: string } | null {
  const wd = bot.chatWorkdir(chatId);
  const skills = bot.fetchSkills(wd).skills;
  const skill = indexSkillsByCommand(skills).get(cmd);
  if (!skill) return null;
  const extra = args.trim();
  const suffix = extra ? ` Additional context: ${extra}` : '';
  const workdirHint = `[Project directory: ${wd}]\n\n`;
  let prompt: string;
  const paths = getProjectSkillPaths(wd, skill.name);
  const skillFile = paths.claudeSkillFile || paths.sharedSkillFile || paths.agentsSkillFile;
  if (skillFile) {
    prompt = `${workdirHint}Read the skill definition at \`${relSkillPath(wd, skillFile)}\` and execute the instructions defined there.${suffix}`;
  } else {
    const fallbackPath = relSkillPath(wd, path.join(wd, '.pikiloom', 'skills', skill.name, 'SKILL.md'));
    prompt = `${workdirHint}Read the skill definition at \`${fallbackPath}\` and execute the instructions defined there.${suffix}`;
  }
  return { prompt, skillName: skill.name };
}

export interface ExtensionSummaryData {
  mcpCount: number;
  mcpExtensions: Array<{ name: string; scope: string; enabled: boolean; command: string }>;
  skillCount: number;
  skills: Array<{ name: string; scope: string; label: string }>;
}

export function getExtensionSummaryData(bot: Bot, chatId: ChatId): ExtensionSummaryData {
  const workdir = bot.chatWorkdir(chatId);
  const mcpExts = listAllMcpExtensions(workdir) as Array<{ name: string; scope: string; config: { enabled?: boolean; disabled?: boolean; command?: string; args?: string[] } }>;
  const skillResult = listAllSkills(workdir) as { skills: Array<{ name: string; scope: string; label: string | null }> };

  return {
    mcpCount: mcpExts.length,
    mcpExtensions: mcpExts.map(e => ({
      name: e.name,
      scope: e.scope,
      enabled: e.config.enabled !== false && !e.config.disabled,
      command: [e.config.command || '', ...(e.config.args || [])].join(' ').trim(),
    })),
    skillCount: skillResult.skills.length,
    skills: skillResult.skills.map((s: any) => ({
      name: s.name,
      scope: s.scope || 'project',
      label: s.label || s.name,
    })),
  };
}

export { summarizePromptForStatus, fmtTokens, fmtUptime, fmtBytes, VERSION };
