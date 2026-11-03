import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { AI_ANSWER_FAILURES } from "./aiVisibilityErrors";
import { failAiRun } from "./aiVisibilityRuns";

export async function finalizeAiRun(runId: string) {
  const run = await repo.getRunInternal(runId);
  if (!run || run.status !== "running") return;
  await repo.failPendingObservations(runId, AI_ANSWER_FAILURES.notArrived);
  const statuses = await repo.getObservationStatuses([runId]);
  const completed = statuses.filter((row) => row.status === "completed").length;
  const status =
    completed === statuses.length
      ? "completed"
      : completed > 0
        ? "partial"
        : "failed";
  await repo.updateRun(runId, {
    status,
    completedAt: new Date().toISOString(),
  });
  await repo.updateTracker(run.trackerId, {
    lastSkipReason: status === "failed" ? AI_ANSWER_FAILURES.runFailed : null,
  });
}

export async function markAiRunFailed(runId: string) {
  const message = AI_ANSWER_FAILURES.runFailed;
  await failAiRun(runId, message);
  const run = await repo.getRunInternal(runId);
  if (run) await repo.updateTracker(run.trackerId, { lastSkipReason: message });
}
