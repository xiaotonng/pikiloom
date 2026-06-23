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

export type VariantProps<T extends TvResult<VariantMap>> = {
  [K in keyof T['variants']]?: keyof T['variants'][K];
};
