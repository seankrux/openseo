import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import {
  collectAiLiveBatch,
  collectAiModelBatch,
} from "./aiVisibilityCollection";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";
import { getTracker } from "./aiVisibilityState";
import { configuration, customer } from "./aiVisibilityTestFixtures";

const { testDb, mocks } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    mocks: {
      env: vi.fn(),
      fetch: vi.fn(),
      provider: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
    },
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: mocks.env,
  isHostedServerAuthMode: async () => false,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  MAX_TASKS_PER_POST: 100,
  createDataforseoClient: () => ({
    aiSearch: {
      llmResponse: mocks.provider,
      trackingLiveBatch: mocks.provider,
      trackingTaskPost: mocks.provider,
    },
  }),
  fetchAiTrackingTaskResult: vi.fn(),
}));
vi.mock("@/server/lib/dataforseo/llm-models", () => ({
  resolveLatestLlmModelName: mocks.provider,
}));
vi.mock("@/server/features/ai-search/services/access", () => ({
  assertPaidAiSearchPlan: async () => undefined,
}));
vi.mock("@/server/lib/r2-cache", () => ({
  AI_SEARCH_PROMPT_CACHE_NAMESPACE: "ai-search:prompt-response",
  buildCacheKey: async (namespace: string, params: unknown) =>
    `${namespace}:${JSON.stringify(params)}`,
  getCached: mocks.read,
  setCached: mocks.write,
}));

const proxyEnv: Record<string, string> = {
  OPENROUTER_BASE_URL: "http://unused.invalid/v1",
  OPENROUTER_API_KEY: "test-key",
};
const input = {
  projectId: "project",
  prompt: "Which SEO tools?",
  models: ["chat_gpt"] as const,
  webSearch: true,
};
const market = { locationCode: 2840, languageCode: "en" };
const engines = [
  "chatgpt",
  "gemini",
  "claude",
  "perplexity",
  "google_ai_overview",
] as const;

function setPerplexityRoute(route: string) {
  mocks.env.mockImplementation(async (key: string) =>
    key === "PROXY_LLM_MODEL_PERPLEXITY" ? route : proxyEnv[key],
  );
}

beforeEach(async () => {
  vi.stubEnv("TEST_PROXY_LLM", "true");
  mocks.env.mockImplementation(async (key: string) => proxyEnv[key]);
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(undefined);
  mocks.provider.mockRejectedValue(
    new Error("DataForSEO must not be called by these proxy tests"),
  );
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    if (typeof init.body !== "string") throw new Error("Expected a JSON body");
    const request: unknown = JSON.parse(init.body);
    if (!request || typeof request !== "object" || !("model" in request))
      throw new Error("Expected a model in the JSON body");
    return Response.json({
      model: request.model,
      choices: [
        {
          message: {
            content: "Try OpenSEO: [example](https://example.com/generated).",
          },
        },
      ],
    });
  });
  vi.stubGlobal("fetch", mocks.fetch);
  await testDb.seedProject();
  const rows = configuration({
    engines: [...engines],
    prompts: [{ text: input.prompt }],
  });
  await repo.saveConfiguration(rows);
  await repo.createRun(
    {
      id: "run",
      trackerId: rows.tracker.id,
      projectId: "project",
      trigger: "manual",
      status: "running",
      ...market,
      createdAt: "2026-09-05T12:00:00.000Z",
    },
    engines.map((engine) => ({
      id: `answer-${engine}`,
      runId: "run",
      promptId: rows.prompts[0].id,
      engine,
      branded: false,
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("proxy model and evidence accuracy through public services", () => {
  it("describes proxy answers as API responses and exposes unavailable engines before collection", async () => {
    await repo.updateRun("run", { status: "completed" });
    const state = await getTracker({ projectId: "project" });
    expect(state.providerConfigured).toBe(true);
    for (const engine of ["chatgpt", "claude", "gemini"]) {
      expect(
        state.capabilities.find((item) => item.engine === engine),
      ).toMatchObject({
        modelApi: true,
        available: true,
      });
    }
    expect(
      state.capabilities.find((item) => item.engine === "google_ai_overview"),
    ).toMatchObject({
      available: false,
      unavailableReason: "Requires captured Google results through DataForSEO.",
    });
    expect(
      state.capabilities.find((item) => item.engine === "perplexity"),
    ).toMatchObject({
      modelApi: true,
      available: false,
      unavailableReason:
        "Requires a configured Perplexity API route or DataForSEO.",
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("exposes an explicit Perplexity route without promising a consumer-site capture", async () => {
    await repo.updateRun("run", { status: "completed" });
    setPerplexityRoute("perplexity/sonar-pro");
    const state = await getTracker({ projectId: "project" });
    expect(
      state.capabilities.find((item) => item.engine === "perplexity"),
    ).toMatchObject({
      modelApi: true,
      available: true,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps DataForSEO consumer captures distinct from model API answers", async () => {
    await repo.updateRun("run", { status: "completed" });
    mocks.env.mockImplementation(async (key: string) =>
      key === "DATAFORSEO_API_KEY" ? "configured-provider" : undefined,
    );
    const state = await getTracker({ projectId: "project" });
    expect(state.capabilities.every((item) => item.available)).toBe(true);
    expect(
      state.capabilities.find((item) => item.engine === "chatgpt"),
    ).toMatchObject({ modelApi: false });
    expect(
      state.capabilities.find((item) => item.engine === "gemini"),
    ).toMatchObject({ modelApi: false });
    expect(
      state.capabilities.find((item) => item.engine === "claude"),
    ).toMatchObject({ modelApi: true });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves the actual ChatGPT, Claude and Gemini model routes without inventing web-search citations", async () => {
    const result = await explorePrompt(
      { ...input, models: ["chat_gpt", "claude", "gemini", "perplexity"] },
      customer,
    );

    expect(result.results).toMatchObject([
      {
        model: "chat_gpt",
        modelName: "gpt-5.6-luna",
        status: "success",
        webSearch: false,
        citations: [],
      },
      {
        model: "claude",
        modelName: "claude-sonnet-4-5",
        status: "success",
        webSearch: false,
        citations: [],
      },
      {
        model: "gemini",
        modelName: "gemini-3-flash-preview",
        status: "success",
        webSearch: false,
        citations: [],
      },
      { model: "perplexity", status: "error" },
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("preserves an explicit Perplexity route and its returned model identity", async () => {
    setPerplexityRoute("perplexity/sonar-pro");
    const result = await explorePrompt(
      { ...input, models: ["perplexity"] },
      customer,
    );
    expect(result.results).toMatchObject([
      {
        model: "perplexity",
        modelName: "perplexity/sonar-pro",
        status: "success",
      },
    ]);
  });

  it("rejects a configured Gemini substitute before calling it Perplexity", async () => {
    setPerplexityRoute("gemini-3-flash-preview");
    const result = await explorePrompt(
      { ...input, models: ["perplexity"] },
      customer,
    );
    expect(result.results).toMatchObject([
      { model: "perplexity", status: "error" },
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("retains only provider citation metadata and an explicit provider search flag", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        web_search: true,
        choices: [
          {
            message: {
              content: "A generated URL: https://example.com/unverified",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/observed",
                    title: "Observed reference",
                  },
                },
                {
                  type: "url_citation",
                  url_citation: {
                    url: "javascript:alert(1)",
                    title: "Invalid",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await explorePrompt(
      { ...input, models: ["chat_gpt"] },
      customer,
    );
    expect(result.results).toMatchObject([
      {
        status: "success",
        webSearch: true,
        citations: [
          { url: "https://example.com/observed", title: "Observed reference" },
        ],
      },
    ]);
  });

  it("does not reuse earlier proxy answers with inferred search or citation evidence", async () => {
    mocks.read.mockImplementation(async (key: string) =>
      key.includes('"systemPromptV":7')
        ? {
            model: "chat_gpt",
            status: "success",
            modelName: "gpt-5.6-luna",
            text: "Old fabricated search",
            citations: [],
            fanOutQueries: [],
            brandMentioned: null,
            outputTokens: null,
            webSearch: true,
            webSearchCountryCode: null,
          }
        : null,
    );
    const result = await explorePrompt(
      { ...input, models: ["chat_gpt"] },
      customer,
    );
    expect(result.results).toMatchObject([
      { status: "success", webSearch: false },
    ]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining('"systemPromptV":8'),
      expect.any(Object),
      expect.any(Number),
      expect.any(Object),
    );
  });

  it("marks Google AI Overview unavailable rather than saving a model completion or an invented absence", async () => {
    await collectAiLiveBatch("run", customer, market, [
      {
        tag: "answer-google_ai_overview",
        prompt: input.prompt,
        engine: "google_ai_overview",
      },
    ]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(
      await repo.getObservation("answer-google_ai_overview"),
    ).toMatchObject({
      engine: "google_ai_overview",
      status: "failed",
      error: "AI_MODEL_NOT_CONFIGURED",
      answerMarkdown: null,
    });
    expect(
      (await repo.getEvidence(["answer-google_ai_overview"])).sources,
    ).toEqual([]);
  });

  it("fails unsupported Perplexity tracking without storing a substitute answer", async () => {
    await collectAiModelBatch("run", customer, market, {
      engine: "perplexity",
      tasks: [{ tag: "answer-perplexity", prompt: input.prompt }],
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await repo.getObservation("answer-perplexity")).toMatchObject({
      engine: "perplexity",
      status: "failed",
      error: "AI_MODEL_NOT_CONFIGURED",
      answerMarkdown: null,
    });
  });

  it("fails a mismatched returned model before persisting Perplexity evidence", async () => {
    setPerplexityRoute("perplexity/sonar-pro");
    mocks.fetch.mockResolvedValue(
      Response.json({
        model: "gemini-3-flash-preview",
        choices: [{ message: { content: "A Gemini answer" } }],
      }),
    );
    await collectAiModelBatch("run", customer, market, {
      engine: "perplexity",
      tasks: [{ tag: "answer-perplexity", prompt: input.prompt }],
    });
    expect(await repo.getObservation("answer-perplexity")).toMatchObject({
      status: "failed",
      error: "AI_MODEL_NOT_CONFIGURED",
      answerMarkdown: null,
    });
    expect((await repo.getEvidence(["answer-perplexity"])).sources).toEqual([]);
  });

  it("stores a valid Perplexity model answer without promoting generated URLs to citation evidence", async () => {
    setPerplexityRoute("perplexity/sonar-pro");
    await collectAiModelBatch("run", customer, market, {
      engine: "perplexity",
      tasks: [{ tag: "answer-perplexity", prompt: input.prompt }],
    });
    expect(await repo.getObservation("answer-perplexity")).toMatchObject({
      engine: "perplexity",
      status: "completed",
      error: null,
      answerMarkdown: "Try OpenSEO: [example](https://example.com/generated).",
    });
    expect((await repo.getEvidence(["answer-perplexity"])).sources).toEqual([]);
  });
});
