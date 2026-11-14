import { checkDomainHealth } from "./check-domain";
import type { CheckBatchOptions, DomainHealthResult } from "./types";

/**
 * Check many domains with a fixed concurrency pool. Memory stays small:
 * only `concurrency` in-flight promises; results accumulate as plain objects.
 */
export async function checkDomainHealthBatch(
  domains: string[],
  options: CheckBatchOptions = {},
): Promise<DomainHealthResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 20);
  const results: DomainHealthResult[] = new Array(domains.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= domains.length) return;
      const result = await checkDomainHealth(domains[i]!, options);
      results[i] = result;
      done += 1;
      options.onProgress?.(done, domains.length, result);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, domains.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
