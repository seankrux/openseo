import type { WorkflowStep } from "cloudflare:workers";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type {
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import {
  rankFromOrganicSerp,
  type SerpProvider,
} from "@/server/lib/serp-provider";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import { KEYWORDS_PER_BATCH } from "@/shared/rank-tracking";
import { pgStep } from "@/server/workflows/pgStep";
import type { CheckContext } from "@/server/workflows/rankCheckPaths";
import {
  expandToTaskInputs,
  persistSettledBatch,
} from "@/server/workflows/rankCheckSnapshots";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

// Lookups in flight at once within a batch step. Semrush allows about 10
// requests per second per key; this stays under it with room for the other
// workflows sharing the key.
const LOOKUP_CONCURRENCY = 5;

type LookupCheckContext = Omit<CheckContext, "client"> & {
  provider: SerpProvider;
};

/**
 * Check keywords through a lookup provider (one call per keyword/device pair,
 * no task queue), writing snapshots after each batch so partial results
 * survive a failed batch. A failed lookup misses this run and its reason is
 * recorded on the run; there is no fallback path to retry it.
 */
export async function runSerpLookupCheck(
  step: WorkflowStep,
  ctx: LookupCheckContext,
): Promise<void> {
  const countryCode = getIsoCountryCode(ctx.locationCode);
  const lookup = async (task: RankCheckTaskInput) =>
    rankFromOrganicSerp(
      {
        keywordId: task.keywordId,
        keyword: task.keyword,
        targetDomain: ctx.domain,
      },
      await ctx.provider.organicSerp({
        keyword: task.keyword,
        countryCode,
        locationName: ctx.locationName ?? null,
        device: task.device,
        depth: ctx.serpDepth,
      }),
    );

  for (let i = 0; i < ctx.keywords.length; i += KEYWORDS_PER_BATCH) {
    const keywordBatch = ctx.keywords.slice(i, i + KEYWORDS_PER_BATCH);
    const tasks = expandToTaskInputs(keywordBatch, ctx.devices);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);
    const keywordsChecked = i + keywordBatch.length;
    try {
      await pgStep(
        step,
        `${ctx.provider.id}-batch-${batchIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const settled: PromiseSettledResult<RankCheckResult>[] = [];
          for (let j = 0; j < tasks.length; j += LOOKUP_CONCURRENCY) {
            settled.push(
              ...(await Promise.allSettled(
                tasks.slice(j, j + LOOKUP_CONCURRENCY).map(lookup),
              )),
            );
          }
          const written = await persistSettledBatch(ctx.runId, tasks, settled);
          // Progress for the UI; finalize recounts from the DB anyway.
          await RankTrackingRepository.updateRun(ctx.runId, {
            keywordsChecked,
          });
          return written;
        },
      );
    } catch (error) {
      // Earlier batches are already saved; finalize reports the gap.
      console.warn(
        `[rank-check] ${ctx.runId} ${ctx.provider.id}-batch-${batchIndex} failed:`,
        error,
      );
    }
  }
}
