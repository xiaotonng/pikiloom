import { Hono } from 'hono';
import { LOCAL_MODELS, type LocalModelEntry } from '../../catalog/local-models.js';
import {
  listProviders, addProvider, listProfiles, addProfile,
  type ProviderConfig,
} from '../../model/index.js';

const router = new Hono();

type BackendId = 'ollama' | 'mlx';
type OsKey = 'darwin' | 'linux' | 'win';

interface InstallCommand { label?: string; cmd: string }

interface InstallSpec {
  darwin?: InstallCommand[];
  linux?: InstallCommand[];
  win?: InstallCommand[];
  docs?: string;
}

interface BackendSpec {
  id: BackendId;
  label: string;
  baseURL: string;
  openAIBaseURL: string;
  probePath: string;
  homepage: string;
  install: InstallSpec;
  runHint: InstallCommand;
  pullCommandTemplate: string;
  modelField: keyof Pick<LocalModelEntry, 'ollamaTag' | 'mlxModel'>;
  platforms: OsKey[];
}

const BACKENDS: BackendSpec[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseURL: 'http://127.0.0.1:11434',
    openAIBaseURL: 'http://127.0.0.1:11434/v1',
    probePath: '/api/version',
    homepage: 'https://ollama.com/',
    install: {
      docs: 'https://github.com/ollama/ollama#ollama',
      darwin: [
        { label: 'Homebrew', cmd: 'brew install ollama' },
        { label: 'Install script', cmd: 'curl -fsSL https://ollama.com/install.sh | sh' },
      ],
      linux: [
        { label: 'Install script', cmd: 'curl -fsSL https://ollama.com/install.sh | sh' },
      ],
      win: [
        { label: 'winget', cmd: 'winget install Ollama.Ollama' },
      ],
    },
    runHint: { label: 'Start the daemon', cmd: 'ollama serve' },
    pullCommandTemplate: 'ollama pull ${model}',
    modelField: 'ollamaTag',
    platforms: ['darwin', 'linux', 'win'],
  },
  {
    id: 'mlx',
    label: 'mlx-lm',
    baseURL: 'http://127.0.0.1:8080',
    openAIBaseURL: 'http://127.0.0.1:8080/v1',
    probePath: '/v1/models',
    homepage: 'https://github.com/ml-explore/mlx-lm',
    install: {
      docs: 'https://github.com/ml-explore/mlx-lm#installation',
      darwin: [
        { label: 'pipx (recommended)', cmd: 'pipx install mlx-lm' },
        { label: 'pip', cmd: 'pip install mlx-lm' },
      ],
    },
    runHint: {
      label: 'Start the server (replace model)',
      cmd: 'mlx_lm.server --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --port 8080',
    },
    pullCommandTemplate: 'mlx_lm.server --model ${model} --port 8080',
    modelField: 'mlxModel',
    platforms: ['darwin'],
  },
];

const PROBE_TIMEOUT_MS = 1500;

async function fetchJson<T>(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function currentOs(): OsKey {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

interface DetectedModel {
  id: string;
  sizeBytes?: number;
}

interface BackendStatus {
  id: BackendId;
  label: string;
  detected: boolean;
  version?: string;
  baseURL: string;
  openAIBaseURL: string;
  models: DetectedModel[];
  existingProviderId: string | null;
  homepage: string;
  install: InstallSpec;
  runHint: InstallCommand;
  pullCommandTemplate: string;
  supportedOnThisOs: boolean;
}

async function probeOllama(spec: BackendSpec): Promise<{ detected: boolean; version?: string; models: DetectedModel[] }> {
  type VersionRes = { version: string };
  type TagsRes = { models?: Array<{ name: string; size?: number }> };
  const ver = await fetchJson<VersionRes>(`${spec.baseURL}${spec.probePath}`);
  if (!ver) return { detected: false, models: [] };
  const tags = await fetchJson<TagsRes>(`${spec.baseURL}/api/tags`, 3000);
  const models: DetectedModel[] = (tags?.models || []).map(m => ({
    id: m.name,
    sizeBytes: typeof m.size === 'number' ? m.size : undefined,
  }));
  return { detected: true, version: ver.version, models };
}

async function probeMlx(spec: BackendSpec): Promise<{ detected: boolean; version?: string; models: DetectedModel[] }> {
  type ModelsRes = { data?: Array<{ id: string }> };
  const res = await fetchJson<ModelsRes>(`${spec.baseURL}${spec.probePath}`, 3000);
  if (!res) return { detected: false, models: [] };
  return {
    detected: true,
    models: (res.data || []).map(m => ({ id: m.id })),
  };
}

function normalizeBaseURL(raw: string): string {
  return raw
    .replace(/\/+$/, '')
    .replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
    .replace(/^https:\/\/localhost(?=[:/]|$)/i, 'https://127.0.0.1');
}

function findProviderForBackend(providers: ProviderConfig[], spec: BackendSpec): ProviderConfig | null {
  const target = normalizeBaseURL(spec.openAIBaseURL);
  return providers.find(p => normalizeBaseURL(p.baseURL) === target) || null;
}

async function probeBackend(spec: BackendSpec, providers: ProviderConfig[]): Promise<BackendStatus> {
  const os = currentOs();
  const supported = spec.platforms.includes(os);
  const result = !supported
    ? { detected: false, models: [] as DetectedModel[] }
    : spec.id === 'ollama' ? await probeOllama(spec) : await probeMlx(spec);
  const existing = findProviderForBackend(providers, spec);
  return {
    id: spec.id,
    label: spec.label,
    detected: result.detected,
    version: result.version,
    baseURL: spec.baseURL,
    openAIBaseURL: spec.openAIBaseURL,
    models: result.models,
    existingProviderId: existing?.id || null,
    homepage: spec.homepage,
    install: spec.install,
    runHint: spec.runHint,
    pullCommandTemplate: spec.pullCommandTemplate,
    supportedOnThisOs: supported,
  };
}

function isEntryInstalled(entry: LocalModelEntry, spec: BackendSpec, installed: DetectedModel[]): string | null {
  const target = entry[spec.modelField];
  if (!target) return null;
  const base = target.split(':')[0].toLowerCase();
  for (const m of installed) {
    if (m.id.toLowerCase().startsWith(base)) return m.id;
  }
  return null;
}

interface CatalogJoinEntry extends LocalModelEntry {
  installed: { backend: BackendId; id: string } | null;
}

function joinCatalog(backends: BackendStatus[]): CatalogJoinEntry[] {
  return LOCAL_MODELS.map(entry => {
    for (const b of backends) {
      if (!b.detected) continue;
      const spec = BACKENDS.find(s => s.id === b.id);
      if (!spec) continue;
      const hit = isEntryInstalled(entry, spec, b.models);
      if (hit) return { ...entry, installed: { backend: b.id, id: hit } };
    }
    return { ...entry, installed: null };
  });
}

function syncLocalProfilesForBackend(providerId: string, detected: DetectedModel[]): { added: number } {
  if (!providerId || !detected.length) return { added: 0 };
  const existing = new Set(
    listProfiles().filter(p => p.providerId === providerId).map(p => p.modelId)
  );
  let added = 0;
  for (const m of detected) {
    if (!m.id || existing.has(m.id)) continue;
    try {
      addProfile({ providerId, modelId: m.id });
      added += 1;
      existing.add(m.id);
    } catch {
    }
  }
  return { added };
}

async function ensureProviderForBackend(spec: BackendSpec): Promise<string | null> {
  const providers = listProviders();
  const existing = findProviderForBackend(providers, spec);
  if (existing) return existing.id;
  try {
    const provider = await addProvider({
      kind: 'openai-compatible',
      name: spec.label,
      baseURL: spec.openAIBaseURL,
      apiKey: 'local-no-auth',
    });
    return provider.id;
  } catch {
    return null;
  }
}

export interface OllamaLibSize {
  tag: string;
  paramsB: number;
  diskGb: number;
  minRamGb: number;
}

export interface OllamaLibModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: OllamaLibSize[];
  pulls: string;
  updated: string;
  url: string;
}

const OLLAMA_QUANT_FACTOR = 0.7;

export function parseOllamaSizeToParamsB(token: string): number | null {
  const t = token.trim().toLowerCase();
  let m = t.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)b$/);
  if (m) return parseFloat(m[1]) * parseFloat(m[2]);
  m = t.match(/^e(\d+(?:\.\d+)?)b$/);
  if (m) return parseFloat(m[1]);
  m = t.match(/^(\d+(?:\.\d+)?)m$/);
  if (m) return parseFloat(m[1]) / 1000;
  m = t.match(/^(\d+(?:\.\d+)?)b$/);
  if (m) return parseFloat(m[1]);
  return null;
}

export function estimateOllamaDiskGb(paramsB: number): number {
  return Math.round(paramsB * OLLAMA_QUANT_FACTOR * 10) / 10;
}

export function estimateOllamaMinRamGb(paramsB: number): number {
  return Math.max(4, Math.round(paramsB * OLLAMA_QUANT_FACTOR * 1.5 + 4));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function allGroups(src: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

export function parseOllamaLibrary(html: string): OllamaLibModel[] {
  const blocks = html.split('<li x-test-model').slice(1);
  const out: OllamaLibModel[] = [];
  for (const b of blocks) {
    const name = b.match(/title="([^"]+)"/)?.[1]?.trim();
    if (!name) continue;
    const descRaw = b.match(/<p[^>]*max-w-lg[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    const description = decodeEntities(descRaw.replace(/<[^>]+>/g, '')).trim();
    const capabilities = allGroups(b, /x-test-capability[^>]*>([^<]+)</g).map(s => s.trim());
    const sizes: OllamaLibSize[] = allGroups(b, /x-test-size[^>]*>([^<]+)</g).map(raw => {
      const tag = raw.trim();
      const paramsB = parseOllamaSizeToParamsB(tag);
      if (paramsB == null) return { tag, paramsB: 0, diskGb: 0, minRamGb: 0 };
      return { tag, paramsB, diskGb: estimateOllamaDiskGb(paramsB), minRamGb: estimateOllamaMinRamGb(paramsB) };
    });
    const pulls = (b.match(/x-test-pull-count[^>]*>([^<]+)</)?.[1] ?? '').trim();
    const updated = (b.match(/x-test-updated[^>]*>([^<]+)</)?.[1] ?? '').trim();
    out.push({ name, description, capabilities, sizes, pulls, updated, url: `https://ollama.com/library/${name}` });
  }
  return out;
}

const OLLAMA_LIBRARY_URL = 'https://ollama.com/library?sort=popular';
const OLLAMA_LIBRARY_TTL_MS = 6 * 60 * 60 * 1000;
const OLLAMA_LIBRARY_TIMEOUT_MS = 12000;

let libraryCache: { at: number; models: OllamaLibModel[] } | null = null;
let libraryInflight: Promise<OllamaLibModel[]> | null = null;

async function fetchOllamaLibrary(): Promise<OllamaLibModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_LIBRARY_TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_LIBRARY_URL, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (pikiloom local-models)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = parseOllamaLibrary(await res.text());
    if (!models.length) throw new Error('no models parsed from Ollama library');
    return models;
  } finally {
    clearTimeout(timer);
  }
}

async function getOllamaLibrary(force: boolean): Promise<{ models: OllamaLibModel[]; fetchedAt: number; stale: boolean }> {
  const fresh = libraryCache && Date.now() - libraryCache.at < OLLAMA_LIBRARY_TTL_MS;
  if (libraryCache && fresh && !force) {
    return { models: libraryCache.models, fetchedAt: libraryCache.at, stale: false };
  }
  if (!libraryInflight) {
    libraryInflight = fetchOllamaLibrary()
      .then(models => { libraryCache = { at: Date.now(), models }; return models; })
      .finally(() => { libraryInflight = null; });
  }
  try {
    const models = await libraryInflight;
    return { models, fetchedAt: libraryCache!.at, stale: false };
  } catch (e) {
    if (libraryCache) return { models: libraryCache.models, fetchedAt: libraryCache.at, stale: true };
    throw e;
  }
}

router.get('/api/local-models/ollama-library', async c => {
  try {
    const force = c.req.query('refresh') === '1';
    const { models, fetchedAt, stale } = await getOllamaLibrary(force);
    return c.json({ ok: true, models, fetchedAt, stale });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 502);
  }
});

router.get('/api/local-models/probe', async c => {
  try {
    const initialProviders = listProviders();
    const backends = await Promise.all(BACKENDS.map(spec => probeBackend(spec, initialProviders)));
    const addedProviderIds: string[] = [];
    for (const b of backends) {
      if (!b.detected) continue;
      const spec = BACKENDS.find(s => s.id === b.id);
      if (!spec) continue;
      let providerId = b.existingProviderId;
      if (!providerId) {
        providerId = await ensureProviderForBackend(spec);
        if (providerId) {
          b.existingProviderId = providerId;
          addedProviderIds.push(providerId);
        }
      }
      if (providerId) syncLocalProfilesForBackend(providerId, b.models);
    }
    const catalog = joinCatalog(backends);
    return c.json({ ok: true, backends, catalog, currentOs: currentOs(), addedProviderIds });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

export default router;
