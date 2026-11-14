// Snapshot plumbing shared by the DataForSEO paths (rankCheckPaths.ts) and the
// lookup-provider path (rankCheckLookupPath.ts).
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type {
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

export type KeywordEntry = { id: string; keyword: string };
export type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

export function mapResultsToSnapshotRows(
  runId: string,
  results: RankCheckResultWithDevice[],
) {
  return results.map((r) => ({
    runId,
    trackingKeywordId: r.keywordId,
    keyword: r.keyword,
    device: r.device,
    position: r.position,
    url: r.url,
    serpFeatures:
      r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
  }));
}

/** Expand keywords into one task input per keyword/device pair. */
export function expandToTaskInputs(
  keywords: KeywordEntry[],
  devices: RankTrackingConfig["devices"],
): RankCheckTaskInput[] {
  const deviceList: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  return keywords.flatMap((kw) =>
    deviceList.map((device) => ({
      keyword: kw.keyword,
      keywordId: kw.id,
      device,
    })),
  );
}

/**
 * Write the fulfilled pairs of one batch as snapshots and record the first
 * rejection on the run. Rejections are logged and skipped. Returns the
 * snapshot count written.
 */
export async function persistSettledBatch(
  runId: string,
  tasks: RankCheckTaskInput[],
  settled: PromiseSettledResult<RankCheckResult>[],
): Promise<number> {
  const results: RankCheckResultWithDevice[] = [];
  let firstError: string | null = null;
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results.push({ ...outcome.value, device: tasks[index].device });
      return;
    }
    const reason: unknown = outcome.reason;
    const code = reason instanceof AppError ? reason.code : "UNKNOWN";
    const message = reason instanceof Error ? reason.message : String(reason);
    // Store the bare code so the app shows its provider-unavailable copy;
    // DataForSEO's raw outage text ("Internal Server Error.") reads like our
    // server broke.
    firstError ??= code === "UPSTREAM_UNAVAILABLE" ? code : message;
    // DataForSEO erring on its own side is a provider flake, not our bug: the
    // keyword just misses this run and finalize reports it to the user. Every
    // other rejection (no credits, bad API key) is ours and stays at error.
    const log = code === "UPSTREAM_UNAVAILABLE" ? console.warn : console.error;
    const task = tasks[index];
    log(
      `[rank-check] ${runId} live call failed (${code}) keyword="${task.keyword}" device=${task.device}: ${message}`,
    );
  });
  if (firstError) {
    await RankTrackingRepository.setRunErrorIfEmpty(runId, firstError);
  }
  if (results.length > 0) {
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(runId, results),
    );
  }
  return results.length;
}
