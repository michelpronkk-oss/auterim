export function scopePublicToolProviders<T extends { slug: string }>(
  directory: readonly T[],
  providerSlug?: string,
) {
  if (!providerSlug) return { selected: null, providers: [...directory] };
  const selected = directory.find((provider) => provider.slug === providerSlug) ?? null;
  return { selected, providers: selected ? [selected] : [] };
}

export function scopePublicToolItems<
  T extends { provider: { slug: string } },
  P extends { slug: string },
>(items: readonly T[], directory: readonly P[], providerSlug?: string) {
  const scope = scopePublicToolProviders(directory, providerSlug);
  const allowed = new Set(scope.providers.map((provider) => provider.slug));
  return items.filter((item) => allowed.has(item.provider.slug));
}
