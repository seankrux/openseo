import { sortBy } from "remeda";

/** Preserve input order while limiting the number of in-flight operations. */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results.push({ index, value: await fn(items[index]) });
      }
    }),
  );
  return sortBy(results, (result) => result.index).map(
    (result) => result.value,
  );
}
