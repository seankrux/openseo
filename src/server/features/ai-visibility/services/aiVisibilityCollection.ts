import { NonRetryableError } from "cloudflare:workflows";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  createDataforseoClient,
  fetchAiTrackingTaskResult,
  MAX_TASKS_PER_POST,
  type AiTrackingAnswer,
  type PostedAiTrackingTask,
} from "@/server/lib/dataforseo";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { resolveLatestLlmModelName } from "@/server/lib/dataforseo/llm-models";
import { AppError, asAppError } from "@/server/lib/errors";
import { getProxyLlmConfig, proxyLlmResponse } from "@/server/lib/proxyLlm";
import type { ErrorCode } from "@/shared/error-codes";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import {
  aiEngineUsesModelApi,
  type AiBrand,
  type AiEngine,
} from "@/shared/ai-visibility";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import {
  parseDataforseoAnswer,
  parseLlmResponseAnswer,
  type ParsedAiAnswer,
} from "../providers/dataforseoEvidence";
import { aiBrands } from "./aiVisibilityConfiguration";
import { AI_ANSWER_FAILURES } from "./aiVisibilityErrors";
import { matchAiBrand } from "./aiVisibilityMatching";
import { failAiRun } from "./aiVisibilityRuns";

interface AiTask {
  tag: string;
  prompt: string;
  attempts?: number;
}
interface AiTaskBatch {
  engine: AiEngine;
  tasks: AiTask[];
}
type AiLiveTask = AiTask & { engine: AiEngine };
export type AiPendingTask = PostedAiTrackingTask &
  AiLiveTask & { attempts: number };
interface AiRunMarket {
  locationCode: number;
  languageCode: string;
}

const LIVE_ANSWERS_PER_STEP = 6;
const AI_ANSWER_ATTEMPTS = 3;
const AI_RETRY_DELAY_MS = 3_000;

const waitBeforeRetry = () =>
  new Promise((resolve) => setTimeout(resolve, AI_RETRY_DELAY_MS));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareAiRun(
  runId: string,
): Promise<
  { market: AiRunMarket; modelBatches: AiTaskBatch[] } & (
    | { live: false; batches: AiTaskBatch[] }
    | { live: true; batches: AiLiveTask[][] }
  )
> {
  const run = await repo.getRunInternal(runId);
  // Stale-run cleanup failed it already; a retry would find the same.
  if (!run || (run.status !== "queued" && run.status !== "running"))
    throw new NonRetryableError(`Run ${runId} is no longer active.`);
  const pending = (await repo.getObservations([runId])).filter(
    (row) => row.status === "pending",
  );
  const proxy = await getProxyLlmConfig();
  const live = Boolean(proxy) || run.trigger !== "scheduled";
  await repo.updateRun(runId, { status: "running" });
  const market = {
    locationCode: run.locationCode,
    languageCode: run.languageCode,
  };
  const tasks = pending.map((row) => ({
    tag: row.id,
    prompt: row.prompt,
    engine: row.engine,
  }));
  const modelBatches = engineBatches(
    tasks.filter((task) => aiEngineUsesModelApi(task.engine)),
    LIVE_ANSWERS_PER_STEP,
  );
  const answers = tasks.filter((task) => !aiEngineUsesModelApi(task.engine));
  if (live) {
    const batches: AiLiveTask[][] = [];
    for (let i = 0; i < answers.length; i += LIVE_ANSWERS_PER_STEP)
      batches.push(answers.slice(i, i + LIVE_ANSWERS_PER_STEP));
    return { market, modelBatches, live, batches };
  }
  return {
    market,
    modelBatches,
    live,
    batches: engineBatches(answers, MAX_TASKS_PER_POST),
  };
}

function engineBatches(answers: AiLiveTask[], size: number): AiTaskBatch[] {
  const batches: AiTaskBatch[] = [];
  for (const engine of new Set(answers.map((task) => task.engine))) {
    const tasks = answers
      .filter((task) => task.engine === engine)
      .map(({ tag, prompt, attempts }) => ({ tag, prompt, attempts }));
    for (let i = 0; i < tasks.length; i += size)
      batches.push({ engine, tasks: tasks.slice(i, i + size) });
  }
  return batches;
}

export async function postAiBatch(
  runId: string,
  customer: BillingCustomerContext,
  market: AiRunMarket,
  batch: AiTaskBatch,
): Promise<AiPendingTask[]> {
  const proxy = await getProxyLlmConfig();
  if (proxy) return [];
  let posted: PostedAiTrackingTask[] = [];
  let error: ErrorCode = "INTERNAL_ERROR";
  try {
    posted = await createDataforseoClient(customer).aiSearch.trackingTaskPost({
      engine: batch.engine,
      tasks: batch.tasks,
      ...market,
    });
  } catch (cause) {
    error = asAppError(cause)?.code ?? "INTERNAL_ERROR";
    console.warn(`[ai-visibility] ${runId} task_post failed:`, cause);
  }
  const taskIds = new Map(posted.map((task) => [task.tag, task.taskId]));
  const rejected = batch.tasks
    .map((task) => task.tag)
    .filter((tag) => !taskIds.has(tag));
  if (rejected.length)
    await repo.failPendingObservations(runId, error, rejected);
  return batch.tasks.flatMap((task) => {
    const taskId = taskIds.get(task.tag);
    if (!taskId) return [];
    const attempts = (task.attempts ?? 0) + 1;
    return [{ ...task, taskId, engine: batch.engine, attempts }];
  });
}

export async function collectAiLiveBatch(
  runId: string,
  customer: BillingCustomerContext,
  market: AiRunMarket,
  tasks: AiLiveTask[],
) {
  const brands = await runBrands(runId);
  if (!brands) return;
  let remaining = tasks;
  for (let attempt = 1; remaining.length > 0; attempt++) {
    if (attempt > 1) await waitBeforeRetry();
    const answers = await fetchLiveAnswers(customer, market, remaining);
    const retry: AiLiveTask[] = [];
    for (const [index, result] of answers.entries()) {
      const task = remaining[index];
      if (
        result.status === "failed" &&
        result.retryable &&
        attempt < AI_ANSWER_ATTEMPTS
      ) {
        retry.push(task);
        continue;
      }
      try {
        await saveAiOutcome(runId, task, result, brands);
      } catch (error) {
        console.error(
          `[ai-visibility] ${runId} could not save answer ${task.tag}:`,
          error,
        );
      }
    }
    remaining = retry;
  }
}

async function fetchLiveAnswers(
  customer: BillingCustomerContext,
  market: AiRunMarket,
  tasks: AiLiveTask[],
): Promise<AiTrackingAnswer[]> {
  const proxy = await getProxyLlmConfig();
  if (proxy) {
    return Promise.all(
      tasks.map(async (task) => {
        try {
          const result = await proxyLlmResponse(proxy, {
            modelSlug: task.engine,
            userPrompt: task.prompt,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
          });
          const parsed = parseLlmResponseAnswer(result);
          return {
            status: "completed" as const,
            result: {
              datetime: new Date().toISOString(),
              markdown: parsed.answerMarkdown,
              sources: parsed.citations.map((c) => ({
                url: c.url,
                title: c.title,
                domain: c.domain,
              })),
            },
          };
        } catch (err) {
          return {
            status: "failed" as const,
            message: errorMessage(err),
            code: asAppError(err)?.code ?? "INTERNAL_ERROR",
            retryable: false,
          };
        }
      }),
    );
  }

  let settled: PromiseSettledResult<AiTrackingAnswer>[];
  try {
    settled = await createDataforseoClient(customer).aiSearch.trackingLiveBatch(
      tasks.map((task) => ({ engine: task.engine, task, ...market })),
    );
  } catch (error) {
    settled = tasks.map(() => ({ status: "rejected", reason: error }));
  }
  return settled.map((outcome) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          status: "failed",
          message: errorMessage(outcome.reason),
          code: asAppError(outcome.reason)?.code ?? "INTERNAL_ERROR",
          retryable: false,
        },
  );
}

export async function collectAiModelBatch(
  runId: string,
  customer: BillingCustomerContext,
  market: AiRunMarket,
  batch: AiTaskBatch,
): Promise<void> {
  const modelSlug = batch.engine;
  if (!aiEngineUsesModelApi(modelSlug))
    throw new AppError("INTERNAL_ERROR", `${modelSlug} has no model API batch`);
  const brands = await runBrands(runId);
  if (!brands) return;

  const proxy = await getProxyLlmConfig();
  if (proxy) {
    await Promise.all(
      batch.tasks.map(async (task) => {
        try {
          const result = await proxyLlmResponse(proxy, {
            modelSlug,
            userPrompt: task.prompt,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
          });
          await saveAiAnswer(task.tag, parseLlmResponseAnswer(result), brands);
        } catch (cause) {
          console.warn(
            `[ai-visibility] proxy ${runId} answer ${task.tag} failed:`,
            cause,
          );
          const code = asAppError(cause)?.code ?? "INTERNAL_ERROR";
          await repo.failPendingObservations(runId, code, [task.tag]);
        }
      }),
    );
    return;
  }

  const client = createDataforseoClient(customer);
  const modelName = await resolveLatestLlmModelName(modelSlug);
  const country = getIsoCountryCode(market.locationCode).toUpperCase();
  await Promise.all(
    batch.tasks.map(async (task) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await client.aiSearch.llmResponse({
            modelSlug,
            modelName,
            userPrompt: task.prompt,
            webSearch: true,
            webSearchCountryCode: country,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
          });
          await saveAiAnswer(task.tag, parseLlmResponseAnswer(result), brands);
          return;
        } catch (cause) {
          if (
            cause instanceof DataforseoChargedTaskError &&
            cause.code === "UPSTREAM_UNAVAILABLE" &&
            attempt < AI_ANSWER_ATTEMPTS
          ) {
            await waitBeforeRetry();
            continue;
          }
          console.warn(
            `[ai-visibility] ${runId} answer ${task.tag} failed:`,
            cause,
          );
          const code = asAppError(cause)?.code ?? "INTERNAL_ERROR";
          await repo.failPendingObservations(runId, code, [task.tag]);
          return;
        }
      }
    }),
  );
}

const MODEL_MAX_OUTPUT_TOKENS = 4096;
const TASK_GET_CONCURRENCY = 25;

export async function collectAiRound(
  runId: string,
  tasks: AiPendingTask[],
  canRetry: boolean,
): Promise<{ pending: AiPendingTask[]; retry: AiTaskBatch[] }> {
  const brands = await runBrands(runId);
  if (!brands) return { pending: [], retry: [] };
  const pending: AiPendingTask[] = [];
  const retry: AiPendingTask[] = [];
  for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
    const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
    const outcomes = await Promise.allSettled(
      chunk.map((task) => fetchAiTrackingTaskResult(task)),
    );
    for (const [index, outcome] of outcomes.entries()) {
      const task = chunk[index];
      if (outcome.status === "rejected" || outcome.value.status === "pending") {
        pending.push(task);
        continue;
      }
      const result = outcome.value;
      if (
        canRetry &&
        result.status === "failed" &&
        result.retryable &&
        task.attempts < AI_ANSWER_ATTEMPTS
      ) {
        retry.push(task);
        continue;
      }
      await saveAiOutcome(runId, task, result, brands);
    }
  }
  return { pending, retry: engineBatches(retry, MAX_TASKS_PER_POST) };
}

async function runBrands(runId: string) {
  const run = await repo.getRunInternal(runId);
  const project = run ? await repo.getProject(run.projectId) : null;
  if (!run || !project) return null;
  return aiBrands(project, await repo.listCompetitors(project.id));
}

async function saveAiOutcome(
  runId: string,
  task: { tag: string; engine: AiEngine },
  outcome: AiTrackingAnswer,
  brands: AiBrand[],
) {
  if (outcome.status === "failed") {
    console.warn(
      `[ai-visibility] ${runId} answer ${task.tag} failed: ${outcome.message}`,
    );
    await repo.failPendingObservations(runId, outcome.code, [task.tag]);
    return;
  }
  const answer = parseDataforseoAnswer(outcome.result, task.engine);
  if (!answer) {
    console.error(
      `[ai-visibility] ${runId} answer ${task.tag} has a shape we cannot read`,
    );
    await repo.failPendingObservations(runId, "INTERNAL_ERROR", [task.tag]);
    return;
  }
  await saveAiAnswer(task.tag, answer, brands);
}

async function saveAiAnswer(
  observationId: string,
  answer: ParsedAiAnswer,
  brands: AiBrand[],
) {
  await repo.persistAnswer({
    observationId,
    values: {
      status: "completed",
      collectedAt: answer.collectedAt ?? new Date().toISOString(),
      answerMarkdown: answer.answerMarkdown,
      error: null,
    },
    sources: answer.citations.map((citation) => ({
      id: crypto.randomUUID(),
      observationId,
      ...citation,
    })),
    matches: brands.map((brand) => ({
      id: crypto.randomUUID(),
      observationId,
      ...brand,
      ...matchAiBrand(answer, brand),
    })),
  });
}

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
