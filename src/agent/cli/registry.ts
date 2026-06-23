import type { CredentialField } from '../mcp/registry.js';

export type CliCategory =
  | 'dev'
  | 'cloud'
  | 'data'
  | 'commerce'
  | 'social'
  | 'content';

export type CliAuthType = 'oauth-web' | 'token' | 'none';

export interface CliInstallCommand {
  cmd: string;
  label?: string;
}

export interface CliInstallSpec {
  darwin?: CliInstallCommand[];
  linux?: CliInstallCommand[];
  win?: CliInstallCommand[];
  docs?: string;
}

export interface CliAuthSpec {
  type: CliAuthType;
  statusArgv?: string[];
  statusReadyPattern?: string;
  loginArgv?: string[];
  logoutArgv?: string[];
  manualLoginCommands?: { label?: string; cmd: string }[];
  tokenFields?: CredentialField[];
  applyTokenArgv?: string[];
  envKey?: string;
  loginHint?: string;
  loginHintZh?: string;
}

export interface RecommendedCli {
  id: string;
  binary: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: CliCategory;
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  install: CliInstallSpec;
  auth: CliAuthSpec;
  versionArgv?: string[];
  recommendedScope?: 'global' | 'workspace' | 'both';
}

import { CLI_TOOLS } from '../../catalog/index.js';

const RECOMMENDED_CLIS: RecommendedCli[] = CLI_TOOLS;

export function getRecommendedClis(): RecommendedCli[] {
  return RECOMMENDED_CLIS;
}

export function getRecommendedCli(id: string): RecommendedCli | undefined {
  return RECOMMENDED_CLIS.find(c => c.id === id);
}
