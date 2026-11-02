// An OpenAI-compatible proxy can supply model answers and prompt ideation.
// It cannot supply measured SEO metrics or captured Google AI Overview results.
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import type { LlmResponseResult } from "@/server/lib/dataforseoLlmSchemas";
import { AppError } from "@/server/lib/errors";
import { safeHttpUrl } from "@/shared/safe-url";

export type ProxyModelSlug =
  | "chat_gpt"
  | "chatgpt"
  | "claude"
  | "gemini"
  | "perplexity"
  | "google_ai_overview";

const DEFAULT_PROXY_MODELS: Record<ProxyModelSlug, string | null> = {
  chat_gpt: "gpt-5.6-luna",
  chatgpt: "gpt-5.6-luna",
  claude: "claude-sonnet-4-5",
  gemini: "gemini-3-flash-preview",
  perplexity: null,
  google_ai_overview: null,
};

const ENV_KEYS: Record<ProxyModelSlug, string> = {
  chat_gpt: "PROXY_LLM_MODEL_CHATGPT",
  chatgpt: "PROXY_LLM_MODEL_CHATGPT",
  claude: "PROXY_LLM_MODEL_CLAUDE",
  gemini: "PROXY_LLM_MODEL_GEMINI",
  perplexity: "PROXY_LLM_MODEL_PERPLEXITY",
  google_ai_overview: "PROXY_LLM_MODEL_GEMINI",
};

export type ProxyLlmConfig = { baseURL: string; apiKey: string };

/** The proxy, only when DataForSEO is not configured. */
export async function getProxyLlmConfig(): Promise<ProxyLlmConfig | null> {
  if (
    typeof process !== "undefined" &&
    process.env?.VITEST === "true" &&
    process.env?.TEST_PROXY_LLM !== "true"
  ) {
    return null;
  }
  if (await getOptionalEnvValue("DATAFORSEO_API_KEY")) return null;
  const baseURL = (
    (await getOptionalEnvValue("OPENROUTER_BASE_URL")) ??
    (await getOptionalEnvValue("AI_VISIBILITY_LLM_BASE_URL"))
  )?.trim();
  if (!baseURL) return null;
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey:
      (await getOptionalEnvValue("OPENROUTER_API_KEY")) ??
      (await getOptionalEnvValue("AI_VISIBILITY_LLM_API_KEY")) ??
      "none",
  };
}

export async function proxyModelName(
  slug: ProxyModelSlug,
): Promise<string | null> {
  // An LLM completion is never evidence of a Google SERP AI Overview.
  if (slug === "google_ai_overview") return null;
  const override = (await getOptionalEnvValue(ENV_KEYS[slug]))?.trim();
  const model = override || DEFAULT_PROXY_MODELS[slug];
  if (slug === "perplexity" && model && !isPerplexityModel(model)) return null;
  return model;
}

export class ProxyModelUnavailableError extends AppError {
  constructor(message: string) {
    super("AI_MODEL_NOT_CONFIGURED", message);
    this.name = "ProxyModelUnavailableError";
  }
}

function isPerplexityModel(model: string): boolean {
  return /^(?:perplexity\/)?(?:sonar(?:[-\w.]+)?|r1-1776)(?::[\w-]+)?$/i.test(
    model,
  );
}

const proxyCitationSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
});
const proxyCompletionSchema = z.object({
  model: z.string().optional(),
  // A provider flag is evidence of search; URLs in generated prose are not.
  web_search: z.boolean().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          annotations: z
            .array(
              z.object({
                type: z.string().optional(),
                url: z.string().optional(),
                title: z.string().nullish(),
                url_citation: proxyCitationSchema.optional(),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .optional(),
  usage: z
    .object({ completion_tokens: z.number().nonnegative().nullish() })
    .optional(),
});

/** One chat completion, shaped like a DataForSEO llm_responses result. */
export async function proxyLlmResponse(
  config: ProxyLlmConfig,
  input: {
    modelSlug: ProxyModelSlug;
    userPrompt: string;
    systemPrompt?: string;
    maxOutputTokens?: number;
  },
): Promise<LlmResponseResult> {
  const model = await proxyModelName(input.modelSlug);
  if (!model)
    throw new ProxyModelUnavailableError(
      input.modelSlug === "google_ai_overview"
        ? "Google AI Overview requires captured Google SERP evidence through DataForSEO, not a model completion."
        : "Configure a matching model route or DataForSEO. Perplexity requires an explicit Perplexity/Sonar route.",
    );
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  messages.push({ role: "user", content: input.userPrompt });

  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Math.min(Math.max(input.maxOutputTokens ?? 2048, 256), 4096),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `proxy ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = proxyCompletionSchema.parse(await res.json());
  if (
    input.modelSlug === "perplexity" &&
    (!body.model || !isPerplexityModel(body.model))
  ) {
    throw new ProxyModelUnavailableError(
      "The proxy did not identify a Perplexity model. Configure a valid Perplexity/Sonar route or DataForSEO.",
    );
  }
  const message = body.choices?.[0]?.message;
  const text = message?.content?.trim() ?? "";
  if (!text) throw new Error(`proxy ${model} returned an empty answer`);
  const annotations = (message?.annotations ?? []).flatMap((annotation) => {
    if (annotation.type !== "url_citation") return [];
    const citation = annotation.url_citation ?? annotation;
    const url = safeHttpUrl(citation.url);
    return url
      ? [{ type: "url_citation", title: citation.title ?? url, url }]
      : [];
  });
  return {
    model_name: body.model ?? model,
    output_tokens: body.usage?.completion_tokens ?? null,
    web_search: body.web_search ?? null,
    items: [
      {
        type: "message",
        sections: [{ type: "text", text, annotations }],
      },
    ],
    fan_out_queries: [],
  };
}
