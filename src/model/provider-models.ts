import { getProvider } from './store.js';
import { validateProvider, type ProviderModelInfo } from './validation.js';
import type { ProviderConfig } from './types.js';

const TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  models: string[];
  modelInfos: ProviderModelInfo[];
  fetchedAt: number;
  providerUpdatedAt: string;
}

const GLOBAL_KEY = Symbol.for('pikiloom.providerModelsCache');
const _existing = (globalThis as any)[GLOBAL_KEY] as Map<string, CacheEntry> | undefined;
const cache: Map<string, CacheEntry> = _existing || new Map<string, CacheEntry>();
if (!_existing) (globalThis as any)[GLOBAL_KEY] = cache;

function isFresh(entry: CacheEntry, provider: ProviderConfig): boolean {
  if (entry.providerUpdatedAt !== provider.updatedAt) return false;
  return (Date.now() - entry.fetchedAt) < TTL_MS;
}

export async function getProviderModelList(providerId: string, opts: { forceRefresh?: boolean } = {}): Promise<{
  models: string[];
  modelInfos: ProviderModelInfo[];
  fetchedAt: number;
  fromCache: boolean;
} | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;

  const cached = cache.get(providerId);
  if (!opts.forceRefresh && cached && isFresh(cached, provider)) {
    return {
      models: cached.models,
      modelInfos: cached.modelInfos,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    };
  }

  const result = await validateProvider(provider);
  const entry: CacheEntry = {
    models: result.models,
    modelInfos: result.modelInfos,
    fetchedAt: Date.now(),
    providerUpdatedAt: provider.updatedAt,
  };
  cache.set(providerId, entry);
  return {
    models: entry.models,
    modelInfos: entry.modelInfos,
    fetchedAt: entry.fetchedAt,
    fromCache: false,
  };
}

export function invalidateProviderModels(providerId: string): void {
  cache.delete(providerId);
}

export function peekProviderModelInfo(providerId: string, modelId: string): ProviderModelInfo | null {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const entry = cache.get(providerId);
  if (!entry || !isFresh(entry, provider)) return null;
  return entry.modelInfos.find(info => info.id === modelId) ?? null;
}

export function peekProviderModelList(providerId: string): ProviderModelInfo[] | null {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const entry = cache.get(providerId);
  if (!entry || !isFresh(entry, provider)) return null;
  return entry.modelInfos;
}

export function prefetchProviderModels(providerId: string): void {
  void getProviderModelList(providerId).catch(() => {});
}
