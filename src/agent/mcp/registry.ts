export type McpTransportSpec =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http'; url: string };

export interface CredentialField {
  key: string;
  label: string;
  labelZh: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
}

export type McpAuthSpec =
  | { type: 'none' }
  | { type: 'credentials'; fields: CredentialField[] }
  | {
      type: 'mcp-oauth';
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      registrationEndpoint?: string;
      clientId?: string;
      scopes?: string[];
    };

export type McpCategory = 'dev' | 'productivity' | 'communication' | 'data' | 'search' | 'utility';

export type RecommendedScope = 'global' | 'workspace' | 'both';

export interface RecommendedMcpServer {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: McpCategory;
  recommendedScope: RecommendedScope;
  transport: McpTransportSpec;
  auth: McpAuthSpec;
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  isBuiltin?: boolean;
}

export type SkillCategory = 'general' | 'dev' | 'productivity';

export interface RecommendedSkillRepo {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  skills?: string[];
  category: SkillCategory;
  recommendedScope: RecommendedScope;
  homepage?: string;
  iconUrl?: string;
  pinned?: boolean;
}

export interface McpSearchResult {
  name: string;
  description: string;
  npmPackage?: string;
  source?: string;
  stars?: number;
}

export interface SkillSearchResult {
  name: string;
  description: string;
  source: string;
  author?: string;
  stars?: number;
}

import { MCP_SERVERS, SKILL_REPOS } from '../../catalog/index.js';

const RECOMMENDED_MCP_SERVERS: RecommendedMcpServer[] = MCP_SERVERS;
const RECOMMENDED_SKILL_REPOS: RecommendedSkillRepo[] = SKILL_REPOS;

export function getRecommendedMcpServers(): RecommendedMcpServer[] {
  return RECOMMENDED_MCP_SERVERS;
}

export function getRecommendedMcpServer(id: string): RecommendedMcpServer | undefined {
  return RECOMMENDED_MCP_SERVERS.find(s => s.id === id);
}

export function getRecommendedSkillRepos(): RecommendedSkillRepo[] {
  return RECOMMENDED_SKILL_REPOS;
}

export async function searchMcpServers(query: string, limit = 20): Promise<McpSearchResult[]> {
  if (!query.trim()) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.servers)) {
        return data.servers.map((s: any) => ({
          name: s.name || s.display_name || '',
          description: s.description || '',
          npmPackage: s.npm_package || undefined,
          source: s.repository || s.url || undefined,
          stars: typeof s.stars === 'number' ? s.stars : undefined,
        })).filter((s: McpSearchResult) => s.name);
      }
      if (Array.isArray(data)) {
        return data.slice(0, limit).map((s: any) => ({
          name: s.name || '',
          description: s.description || '',
          source: s.repository || s.url || undefined,
        })).filter((s: McpSearchResult) => s.name);
      }
    }
  } catch {
    clearTimeout(timer);
  }

  try {
    const npmUrl = `https://registry.npmjs.org/-/v1/search?text=mcp+server+${encodeURIComponent(query)}&size=${limit}`;
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 5_000);
    const res = await fetch(npmUrl, { signal: controller2.signal });
    clearTimeout(timer2);

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.objects)) {
        return data.objects.map((o: any) => ({
          name: o.package?.name || '',
          description: o.package?.description || '',
          npmPackage: o.package?.name,
        })).filter((s: McpSearchResult) => s.name);
      }
    }
  } catch {  }

  return [];
}

export async function searchSkills(query: string, limit = 20): Promise<SkillSearchResult[]> {
  if (!query.trim()) return [];
  try {
    const npmUrl = `https://registry.npmjs.org/-/v1/search?text=agent+skill+${encodeURIComponent(query)}&size=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(npmUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = await res.json();

    if (Array.isArray(data.objects)) {
      return data.objects.map((o: any) => ({
        name: o.package?.name || '',
        description: o.package?.description || '',
        source: o.package?.links?.repository || o.package?.name || '',
        author: o.package?.publisher?.username,
      })).filter((s: SkillSearchResult) => s.name);
    }
  } catch {  }
  return [];
}
