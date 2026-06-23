import type { CredentialRef } from '../core/secrets/index.js';

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'google';

export interface ProviderValidationStatus {
  state: 'unknown' | 'ready' | 'invalid' | 'error';
  detail: string;
  checkedAt: string;
  modelCount?: number;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseURL: string;
  credential: CredentialRef;
  extraHeaders?: Record<string, string>;
  validation?: ProviderValidationStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfileConfig {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  maxOutputTokens?: number | null;
  extras?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelLayerConfig {
  providers?: Record<string, ProviderConfig>;
  profiles?: Record<string, ModelProfileConfig>;
  activeProfileByAgent?: Record<string, string | null>;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  release_date?: string;
  last_updated?: string;
  knowledge?: string;
  modalities?: { input?: string[]; output?: string[] };
  open_weights?: boolean;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  api?: string;
  doc?: string;
  npm?: string;
  env?: string[];
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;
