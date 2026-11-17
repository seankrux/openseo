export function ga4CacheKey(projectId: string, propertyId: string) {
  // v2 excludes aggregates collected with the old UTC-based date windows.
  return `portfolio-ga4:v2:${projectId}:${propertyId}`;
}
