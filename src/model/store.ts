import { randomUUID } from 'node:crypto';
import { loadUserConfig, saveUserConfig } from '../core/config/user-config.js';
import { persistSecret, forgetSecret, type CredentialRef } from '../core/secrets/index.js';
import type {
  ProviderConfig, ModelProfileConfig, ModelLayerConfig,
  ProviderKind, ProviderValidationStatus,
} from './types.js';

function getModelLayer(): ModelLayerConfig {
  const config = loadUserConfig();
  return (config.models as ModelLayerConfig) || {};
}

function writeModelLayer(layer: ModelLayerConfig): void {
  const config = loadUserConfig();
  saveUserConfig({ ...config, models: layer });
}

export interface AddProviderInput {
  kind: ProviderKind;
  name: string;
  baseURL: string;
  apiKey?: string;
  credentialRef?: CredentialRef;
  extraHeaders?: Record<string, string>;
}

export function listProviders(): ProviderConfig[] {
  const layer = getModelLayer();
  const map = layer.providers || {};
  return Object.values(map).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProvider(id: string): ProviderConfig | null {
  const layer = getModelLayer();
  return layer.providers?.[id] || null;
}

export async function addProvider(input: AddProviderInput): Promise<ProviderConfig> {
  if (!input.apiKey && !input.credentialRef) {
    throw new Error('addProvider requires either apiKey or credentialRef');
  }
  const id = randomUUID();
  const credential: CredentialRef = input.credentialRef
    ? input.credentialRef
    : await persistSecret(`provider/${id}`, input.apiKey!);
  const now = new Date().toISOString();
  const provider: ProviderConfig = {
    id,
    kind: input.kind,
    name: input.name.trim(),
    baseURL: input.baseURL.trim().replace(/\/+$/, ''),
    credential,
    extraHeaders: input.extraHeaders && Object.keys(input.extraHeaders).length ? input.extraHeaders : undefined,
    validation: null,
    createdAt: now,
    updatedAt: now,
  };
  const layer = getModelLayer();
  const providers = { ...(layer.providers || {}) };
  providers[id] = provider;
  writeModelLayer({ ...layer, providers });
  return provider;
}

export interface UpdateProviderInput {
  name?: string;
  baseURL?: string;
  apiKey?: string;
  credentialRef?: CredentialRef;
  extraHeaders?: Record<string, string> | null;
}

export async function updateProvider(id: string, patch: UpdateProviderInput): Promise<ProviderConfig> {
  const layer = getModelLayer();
  const providers = { ...(layer.providers || {}) };
  const existing = providers[id];
  if (!existing) throw new Error(`Provider not found: ${id}`);

  let credential = existing.credential;
  if (patch.credentialRef) credential = patch.credentialRef;
  else if (patch.apiKey !== undefined) {
    if (existing.credential.source === 'keychain') {
      credential = await persistSecret(existing.credential.account, patch.apiKey);
    } else {
      credential = await persistSecret(`provider/${id}`, patch.apiKey);
    }
  }

  const next: ProviderConfig = {
    ...existing,
    name: patch.name?.trim() ?? existing.name,
    baseURL: patch.baseURL?.trim().replace(/\/+$/, '') ?? existing.baseURL,
    credential,
    extraHeaders: patch.extraHeaders === null
      ? undefined
      : patch.extraHeaders ?? existing.extraHeaders,
    validation: patch.apiKey !== undefined || patch.credentialRef ? null : existing.validation,
    updatedAt: new Date().toISOString(),
  };
  providers[id] = next;
  writeModelLayer({ ...layer, providers });
  return next;
}

export async function removeProvider(id: string): Promise<boolean> {
  const layer = getModelLayer();
  const providers = { ...(layer.providers || {}) };
  const existing = providers[id];
  if (!existing) return false;
  delete providers[id];
  const profiles = { ...(layer.profiles || {}) };
  for (const [pid, prof] of Object.entries(profiles)) {
    if (prof.providerId === id) delete profiles[pid];
  }
  const bindings = { ...(layer.activeProfileByAgent || {}) };
  for (const agentId of Object.keys(bindings)) {
    const profileId = bindings[agentId];
    if (profileId && !profiles[profileId]) bindings[agentId] = null;
  }
  writeModelLayer({ ...layer, providers, profiles, activeProfileByAgent: bindings });
  await forgetSecret(existing.credential).catch(() => {});
  return true;
}

export function setProviderValidation(id: string, status: ProviderValidationStatus | null): void {
  const layer = getModelLayer();
  const providers = { ...(layer.providers || {}) };
  const existing = providers[id];
  if (!existing) return;
  providers[id] = { ...existing, validation: status, updatedAt: new Date().toISOString() };
  writeModelLayer({ ...layer, providers });
}

export interface AddProfileInput {
  name?: string;
  providerId: string;
  modelId: string;
  effort?: ModelProfileConfig['effort'];
  maxOutputTokens?: number | null;
  extras?: Record<string, unknown>;
}

export function listProfiles(): ModelProfileConfig[] {
  const layer = getModelLayer();
  return Object.values(layer.profiles || {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProfile(id: string): ModelProfileConfig | null {
  const layer = getModelLayer();
  return layer.profiles?.[id] || null;
}

function defaultProfileName(_providerName: string, modelId: string, _effort?: string | null): string {
  return modelId;
}

export function addProfile(input: AddProfileInput): ModelProfileConfig {
  const layer = getModelLayer();
  const provider = layer.providers?.[input.providerId];
  if (!provider) throw new Error(`Provider not found: ${input.providerId}`);
  const id = randomUUID();
  const now = new Date().toISOString();
  const profile: ModelProfileConfig = {
    id,
    name: input.name?.trim() || defaultProfileName(provider.name, input.modelId, input.effort),
    providerId: input.providerId,
    modelId: input.modelId.trim(),
    effort: input.effort ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    extras: input.extras,
    createdAt: now,
    updatedAt: now,
  };
  const profiles = { ...(layer.profiles || {}) };
  profiles[id] = profile;
  writeModelLayer({ ...layer, profiles });
  return profile;
}

export type UpdateProfileInput = Partial<Pick<ModelProfileConfig, 'name' | 'modelId' | 'effort' | 'maxOutputTokens' | 'extras'>>;

export function updateProfile(id: string, patch: UpdateProfileInput): ModelProfileConfig {
  const layer = getModelLayer();
  const profiles = { ...(layer.profiles || {}) };
  const existing = profiles[id];
  if (!existing) throw new Error(`Profile not found: ${id}`);
  const next: ModelProfileConfig = {
    ...existing,
    ...('name' in patch && patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
    ...('modelId' in patch && patch.modelId !== undefined ? { modelId: patch.modelId.trim() } : {}),
    ...('effort' in patch ? { effort: patch.effort ?? null } : {}),
    ...('maxOutputTokens' in patch ? { maxOutputTokens: patch.maxOutputTokens ?? null } : {}),
    ...('extras' in patch ? { extras: patch.extras } : {}),
    updatedAt: new Date().toISOString(),
  };
  profiles[id] = next;
  writeModelLayer({ ...layer, profiles });
  return next;
}

export function removeProfile(id: string): boolean {
  const layer = getModelLayer();
  const profiles = { ...(layer.profiles || {}) };
  if (!profiles[id]) return false;
  delete profiles[id];
  const bindings = { ...(layer.activeProfileByAgent || {}) };
  for (const agentId of Object.keys(bindings)) {
    if (bindings[agentId] === id) bindings[agentId] = null;
  }
  writeModelLayer({ ...layer, profiles, activeProfileByAgent: bindings });
  return true;
}

export function getActiveProfileId(agentId: string): string | null {
  const layer = getModelLayer();
  return layer.activeProfileByAgent?.[agentId] || null;
}

export function getActiveProfile(agentId: string): ModelProfileConfig | null {
  const id = getActiveProfileId(agentId);
  if (!id) return null;
  return getProfile(id);
}

export function setActiveProfile(agentId: string, profileId: string | null): void {
  const layer = getModelLayer();
  if (profileId && !layer.profiles?.[profileId]) {
    throw new Error(`Profile not found: ${profileId}`);
  }
  const bindings = { ...(layer.activeProfileByAgent || {}) };
  bindings[agentId] = profileId;
  writeModelLayer({ ...layer, activeProfileByAgent: bindings });
}
