import path from 'node:path';
import { getProjectSkillPaths, listSkills, stageSessionFiles, ensureManagedSession, findPikiloomSession, getDriverCapabilities, isPendingSessionId, type Agent, type HandoverRef } from '../agent/index.js';
import { loadUserConfig } from '../core/config/user-config.js';
import { decomposeEffortSelection } from '../core/config/runtime-config.js';
import { runtime } from './runtime.js';

const KNOWN_AGENTS = new Set<Agent>(['claude', 'codex', 'gemini', 'hermes']);

function parseGoalSlash(prompt: string): { action: 'set' | 'clear' | 'pause' | 'resume' | 'status'; objective: string } | null {
  const trimmed = prompt.trim();
  const m = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const args = (m[1] || '').trim();
  if (!args) return { action: 'status', objective: '' };
  const lower = args.toLowerCase();
  if (lower === 'clear' || lower === 'cancel' || lower === 'stop') return { action: 'clear', objective: '' };
  if (lower === 'pause') return { action: 'pause', objective: '' };
  if (lower === 'resume') return { action: 'resume', objective: '' };
  return { action: 'set', objective: args };
}

function resolveSkillFromPrompt(workdir: string, prompt: string): { resolvedPrompt: string; skillName: string } | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const name = match[1];
  const args = (match[2] || '').trim();

  const { skills } = listSkills(workdir);
  const skill = skills.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return null;

  const extra = args ? ` Additional context: ${args}` : '';
  const workdirHint = `[Project directory: ${workdir}]\n\n`;
  const paths = getProjectSkillPaths(workdir, skill.name);
  const skillFile = paths.claudeSkillFile || paths.sharedSkillFile || paths.agentsSkillFile;
  const targetPath = skillFile || `${workdir}/.pikiloom/skills/${skill.name}/SKILL.md`;
  const resolvedPrompt = `${workdirHint}Read the skill definition at \`${targetPath}\` and execute the instructions defined there.${extra}`;
  return { resolvedPrompt, skillName: skill.name };
}

export interface QueueSessionTaskRequest {
  workdir: string;
  agent?: Agent | string | null;
  sessionId: string;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  workflow?: boolean;
  attachments?: string[];
  previousAgent?: Agent | string | null;
  previousSessionId?: string | null;
}

function resolveHandoverFrom(request: QueueSessionTaskRequest, targetAgent: Agent): HandoverRef | null {
  const prevAgent = typeof request.previousAgent === 'string' ? request.previousAgent.trim() : '';
  const prevSessionId = typeof request.previousSessionId === 'string' ? request.previousSessionId.trim() : '';
  if (!prevAgent || !prevSessionId) return null;
  if (!KNOWN_AGENTS.has(prevAgent as Agent)) return null;
  if (prevAgent === targetAgent) return null;
  if (isPendingSessionId(prevSessionId)) return null;
  const record = findPikiloomSession(request.workdir, prevAgent as Agent, prevSessionId);
  if (!record) return null;
  return { agent: prevAgent as Agent, sessionId: prevSessionId };
}

export async function queueDashboardSessionTask(request: QueueSessionTaskRequest) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  if (!request.workdir || (!request.prompt && !(request.attachments || []).length)) {
    return { ok: false as const, error: 'workdir and either prompt or attachments are required' };
  }

  const config = loadUserConfig();
  const resolvedAgent = typeof request.agent === 'string' && KNOWN_AGENTS.has(request.agent as Agent)
    ? request.agent as Agent
    : runtime.getRuntimeDefaultAgent(config);
  const modelId = typeof request.model === 'string' ? request.model.trim() : '';
  const { effort: splitEffort, workflow: ultraWorkflow } = decomposeEffortSelection(
    typeof request.effort === 'string' ? request.effort : '',
  );
  const thinkingEffort = resolvedAgent === 'gemini' ? '' : splitEffort;
  const workflowEnabled = ultraWorkflow || request.workflow === true;

  const goalCmd = parseGoalSlash(request.prompt || '');
  if (goalCmd && request.sessionId && !isPendingSessionId(request.sessionId)) {
    return runDashboardGoalSlash(bot, resolvedAgent, request, goalCmd, modelId, thinkingEffort);
  }

  let prompt = request.prompt;
  const skillResult = prompt ? resolveSkillFromPrompt(request.workdir, prompt) : null;
  if (skillResult) {
    prompt = skillResult.resolvedPrompt;
    runtime.debug(`[session-send] resolved skill: ${skillResult.skillName}`);
  }

  let sessionId = request.sessionId;
  let attachments = request.attachments || [];

  const isFreshSession = !sessionId || isPendingSessionId(sessionId);
  const handoverFrom = isFreshSession ? resolveHandoverFrom(request, resolvedAgent) : null;

  if (!sessionId || attachments.length) {
    const staged = stageSessionFiles({
      agent: resolvedAgent,
      workdir: request.workdir,
      files: attachments,
      sessionId: sessionId || null,
      title: request.prompt || 'New session',
      threadId: null,
      handoverFrom,
    });
    if (!sessionId) sessionId = staged.sessionId;
    if (staged.importedFiles.length) {
      attachments = staged.importedFiles.map(f => path.join(staged.workspacePath, f));
    }
  }

  return bot.submitSessionTask({
    workdir: request.workdir,
    agent: resolvedAgent,
    sessionId,
    prompt: prompt || 'Please inspect the attached file(s).',
    attachments,
    ...(modelId ? { modelId } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    workflowEnabled,
    ...(handoverFrom ? { handoverFrom } : {}),
  });
}

async function runDashboardGoalSlash(
  bot: NonNullable<ReturnType<typeof runtime.getBotRef>>,
  agent: Agent,
  request: QueueSessionTaskRequest,
  cmd: { action: 'set' | 'clear' | 'pause' | 'resume' | 'status'; objective: string },
  modelId: string,
  thinkingEffort: string,
) {
  const opts = { chatId: 'dashboard' as const, modelId: modelId || undefined, thinkingEffort: thinkingEffort || undefined };
  const sessionKey = `${agent}:${request.sessionId}`;
  const taskId = `goal-${cmd.action}-${Date.now().toString(36)}`;
  try {
    if (cmd.action === 'status') {
      const goal = await bot.getSessionGoal(request.workdir, agent, request.sessionId);
      return { ok: true as const, taskId, sessionKey, queued: false, goal };
    }
    if (cmd.action === 'clear') {
      await bot.clearSessionGoal(request.workdir, agent, request.sessionId, opts);
      return { ok: true as const, taskId, sessionKey, queued: false };
    }
    if (cmd.action === 'pause') {
      const goal = await bot.pauseSessionGoal(request.workdir, agent, request.sessionId);
      return { ok: true as const, taskId, sessionKey, queued: false, goal };
    }
    if (cmd.action === 'resume') {
      const goal = await bot.resumeSessionGoal(request.workdir, agent, request.sessionId, opts);
      return { ok: true as const, taskId, sessionKey, queued: false, goal };
    }
    const goal = await bot.setSessionGoal(request.workdir, agent, request.sessionId, {
      objective: cmd.objective,
      ...opts,
    });
    return { ok: true as const, taskId, sessionKey, queued: true, goal };
  } catch (e: any) {
    return { ok: false as const, error: e?.message || String(e) };
  }
}

export interface ForkSessionTaskRequest {
  workdir: string;
  agent: Agent | string;
  parentSessionId: string;
  atTurn: number;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  attachments?: string[];
}

export function forkDashboardSessionTask(request: ForkSessionTaskRequest) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  if (!request.workdir || !request.parentSessionId || !request.prompt) {
    return { ok: false as const, error: 'workdir, parentSessionId, and prompt are required' };
  }

  if (!KNOWN_AGENTS.has(request.agent as Agent)) {
    return { ok: false as const, error: `Unknown agent: ${request.agent}` };
  }
  const agent = request.agent as Agent;
  if (!getDriverCapabilities(agent).fork) {
    return { ok: false as const, error: `Agent ${agent} does not support fork` };
  }

  const modelId = typeof request.model === 'string' ? request.model.trim() : '';
  const { effort: splitEffort, workflow: ultraWorkflow } = decomposeEffortSelection(
    typeof request.effort === 'string' ? request.effort : '',
  );
  const thinkingEffort = agent === 'gemini' ? '' : splitEffort;

  let prompt = request.prompt;
  const skillResult = prompt ? resolveSkillFromPrompt(request.workdir, prompt) : null;
  if (skillResult) prompt = skillResult.resolvedPrompt;

  ensureManagedSession({
    agent,
    workdir: request.workdir,
    sessionId: request.parentSessionId,
  });

  const staged = stageSessionFiles({
    agent,
    workdir: request.workdir,
    files: request.attachments || [],
    sessionId: null,
    title: request.prompt || `Fork from ${request.parentSessionId.slice(0, 8)}`,
    threadId: null,
  });
  const attachments = staged.importedFiles.length
    ? staged.importedFiles.map(f => path.join(staged.workspacePath, f))
    : [];

  return bot.submitSessionTask({
    workdir: request.workdir,
    agent,
    sessionId: staged.sessionId,
    prompt: prompt || 'Please inspect the attached file(s).',
    attachments,
    forkOf: { parentSessionId: request.parentSessionId, atTurn: request.atTurn },
    ...(modelId ? { modelId } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    ...(ultraWorkflow ? { workflowEnabled: true } : {}),
  });
}

export function getSessionStreamState(agent: string, sessionId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: true as const, state: null };
  return { ok: true as const, state: bot.getStreamSnapshot(`${agent}:${sessionId}`) };
}

export function cancelSessionTask(taskId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.cancelTask(taskId);
  return { ok: true as const, recalled: result.cancelled || result.interrupted };
}

export function stopSessionTasks(agent: string, sessionId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.stopAllSessionTasks(`${agent}:${sessionId}`);
  return { ok: true as const, ...result };
}

export async function steerSessionTask(taskId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = await bot.steerTask(taskId);
  return { ok: true as const, steered: result.steered };
}

export function interactionSelectOption(promptId: string, optionValue: string, opts?: { requestFreeform?: boolean }) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSelectOption(promptId, optionValue, opts);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionSubmitText(promptId: string, text: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSubmitText(promptId, text);
  if (!result) return { ok: false as const, error: 'Prompt not found or not awaiting text' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionSkip(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionSkip(promptId);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const, completed: result.completed, advanced: result.advanced };
}

export function interactionCancel(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const result = bot.interactionCancel(promptId);
  if (!result) return { ok: false as const, error: 'Prompt not found or no longer active' };
  return { ok: true as const };
}

export function getInteractionPrompt(promptId: string) {
  const bot = runtime.getBotRef();
  if (!bot) return { ok: false as const, error: 'Bot is not running' };
  const prompt = bot.interactionPrompt(promptId);
  if (!prompt) return { ok: true as const, prompt: null };
  return {
    ok: true as const,
    prompt: {
      promptId: prompt.promptId,
      taskId: prompt.taskId,
      title: prompt.title,
      hint: prompt.hint,
      questions: prompt.questions,
      currentIndex: prompt.currentIndex,
      answers: prompt.answers,
    },
  };
}
