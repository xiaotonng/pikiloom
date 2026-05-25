/**
 * `tv` — tiny variant resolver. Mirrors `class-variance-authority`'s shape
 * without the dependency. Use when a component has multiple orthogonal
 * variant axes (size, tone, intent) so the class composition stays declarative.
 *
 *   const button = tv({
 *     base: 'inline-flex items-center rounded-md',
 *     variants: {
 *       size: { sm: 'h-7 px-2.5 text-[11px]', md: 'h-8 px-3 text-[13px]' },
 *       tone: { primary: '…', secondary: '…' },
 *     },
 *     defaults: { size: 'md', tone: 'primary' },
 *   });
 *
 *   button({ size: 'sm', tone: 'secondary' }); // → "inline-flex … h-7 px-2.5 … …"
 *
 * Why not just `cva`? One less dep, ~30 LOC, identical ergonomics for our
 * call sites. If we ever want compound variants we can extend it here.
 */

type VariantMap = Record<string, Record<string, string>>;

type Selection<V extends VariantMap> = {
  [K in keyof V]?: keyof V[K] | undefined | false | null;
};

export interface TvConfig<V extends VariantMap> {
  base?: string;
  variants: V;
  defaults?: Partial<{ [K in keyof V]: keyof V[K] }>;
}

export interface TvResult<V extends VariantMap> {
  (selection?: Selection<V> & { className?: string }): string;
  /** Static variant keys, useful for typing component props. */
  variants: V;
}

export function tv<V extends VariantMap>(config: TvConfig<V>): TvResult<V> {
  const { base = '', variants } = config;
  const defaults = (config.defaults ?? {}) as Record<string, string | undefined>;
  const fn = (selection: Selection<V> & { className?: string } = {}) => {
    const parts: string[] = [];
    if (base) parts.push(base);
    for (const key of Object.keys(variants)) {
      const raw = (selection as Record<string, unknown>)[key];
      // Coerce booleans / non-string keys to their string form so consumers
      // can pass `interactive: true` and have us resolve `variants.interactive.true`.
      const chosen: string | undefined =
        raw === false || raw === null || raw === undefined
          ? defaults[key]
          : String(raw);
      if (!chosen) continue;
      const cls = variants[key][chosen];
      if (cls) parts.push(cls);
    }
    if (selection.className) parts.push(selection.className);
    return parts.filter(Boolean).join(' ');
  };
  (fn as TvResult<V>).variants = variants;
  return fn as TvResult<V>;
}

/** Helper type: pull the union of allowed values for a variant axis. */
export type VariantProps<T extends TvResult<VariantMap>> = {
  [K in keyof T['variants']]?: keyof T['variants'][K];
};
