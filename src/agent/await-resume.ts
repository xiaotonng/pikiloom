import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AwaitResumeState } from './types.js';

const AWAIT_FILE = 'awaiting.json';
const MAX_REASON_CHARS = 280;

export function sessionAwaitPath(workdir: string, agent: Agent, sessionId: string): string {
  return path.join(workdir, '.pikiloom', 'sessions', agent, sessionId, AWAIT_FILE);
}

export function readAwaitResume(workdir: string, agent: Agent, sessionId: string): AwaitResumeState | null {
  const file = sessionAwaitPath(workdir, agent, sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : '';
    const since = typeof raw?.since === 'string' ? raw.since.trim() : '';
    if (!since) return null;
    return { reason: reason.slice(0, MAX_REASON_CHARS), since };
  } catch {
    return null;
  }
}

export function clearAwaitResume(workdir: string, agent: Agent, sessionId: string): void {
  try {
    fs.rmSync(sessionAwaitPath(workdir, agent, sessionId), { force: true });
  } catch {
  }
}
