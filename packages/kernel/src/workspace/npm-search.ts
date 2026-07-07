// Shared npm-registry search used by SkillsManager.search and McpRegistry's npm fallback.
// Workspace-internal — not exported by any barrel.

export interface NpmPackageHit {
  name: string;
  description: string | null;
  homepage: string | null;
  author: string | null;
  version: string | null;
}

/** Query registry.npmjs.org's search endpoint. [] on non-OK; throws on network failure. */
export async function searchNpmPackages(text: string, size: number, fetchImpl: typeof fetch): Promise<NpmPackageHit[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await res.json() as any;
  const objects: any[] = Array.isArray(data?.objects) ? data.objects : [];
  return objects.map((o) => {
    const pkg = o?.package ?? {};
    return {
      name: String(pkg.name ?? ''),
      description: pkg.description ?? null,
      homepage: pkg.links?.homepage ?? pkg.links?.npm ?? null,
      author: pkg.publisher?.username ?? pkg.author?.name ?? null,
      version: pkg.version ?? null,
    };
  }).filter(h => h.name);
}
