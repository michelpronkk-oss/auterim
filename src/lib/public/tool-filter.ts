export function scopePublicToolProviders<T extends { slug: string }>(
  directory: readonly T[],
  providerSlug?: string,
) {
  if (!providerSlug) return { selected: null, providers: [...directory] };
  const selected = directory.find((provider) => provider.slug === providerSlug) ?? null;
  return { selected, providers: selected ? [selected] : [] };
}
