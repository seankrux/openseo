import { env } from "cloudflare:workers";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { getEnvValueSync } from "@/server/lib/runtime-env";

const sitesSchema = z.object({
  d: z
    .array(
      z.object({ Url: z.string().url().max(2048), IsVerified: z.boolean() }),
    )
    // Large self-hosted portfolios exceed 1,000 sites. The streamed 1 MiB
    // response limit below still bounds bytes independently of this row limit.
    .max(10_000),
});

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dateSchema = z
  .string()
  .max(64)
  .transform((value, context) => {
    const match = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/.exec(value);
    const milliseconds = match ? Number(match[1]) : NaN;
    const hours = Number(match?.[3] ?? 0);
    const minutes = Number(match?.[4] ?? 0);
    if (
      !match ||
      !Number.isSafeInteger(milliseconds) ||
      Math.abs(milliseconds) > 8_640_000_000_000_000 ||
      hours > 14 ||
      minutes > 59 ||
      (hours === 14 && minutes !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Invalid provider date" });
      return z.NEVER;
    }
    const utcOffsetMinutes = match[2]
      ? (hours * 60 + minutes) * (match[2] === "-" ? -1 : 1)
      : null;
    const localTime = milliseconds + (utcOffsetMinutes ?? 0) * 60_000;
    if (Math.abs(localTime) > 8_640_000_000_000_000) {
      context.addIssue({ code: "custom", message: "Invalid provider date" });
      return z.NEVER;
    }
    return {
      timestamp: new Date(milliseconds).toISOString(),
      utcOffsetMinutes,
      date:
        utcOffsetMinutes === null
          ? null
          : new Date(localTime).toISOString().slice(0, 10),
    };
  });
const performanceSchema = z.object({
  d: z
    .array(
      z.object({
        Date: dateSchema,
        Clicks: countSchema,
        Impressions: countSchema,
      }),
    )
    .max(1000),
});

const crawlSchema = z.object({
  d: z
    .array(
      z.object({
        Date: dateSchema,
        AllOtherCodes: countSchema,
        BlockedByRobotsTxt: countSchema,
        Code2xx: countSchema,
        Code301: countSchema,
        Code302: countSchema,
        Code4xx: countSchema,
        Code5xx: countSchema,
        ContainsMalware: countSchema,
        CrawlErrors: countSchema,
        CrawledPages: countSchema,
        InIndex: countSchema,
        InLinks: countSchema,
        ConnectionTimeout: countSchema.optional(),
        DnsFailures: countSchema.optional(),
      }),
    )
    .max(1000),
});

const providerErrorSchema = z.object({
  ErrorCode: z.number().optional(),
  Message: z.string().optional(),
});

function getConfiguredKey(): string | null {
  const apiKey = getEnvValueSync(env, "BING_WEBMASTER_API_KEY");
  return getEnvValueSync(env, "BING_WEBMASTER_ENABLED") === "true" &&
    apiKey?.trim()
    ? apiKey
    : null;
}

function relayConfig(): { url: string; secret: string } | null {
  const url = getEnvValueSync(env, "BING_WEBMASTER_RELAY_URL")?.trim();
  const secret = getEnvValueSync(env, "BING_WEBMASTER_RELAY_SECRET")?.trim();
  if (!url || !secret) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, secret };
}

function isAvailable(): boolean {
  return (
    getEnvValueSync(env, "BING_WEBMASTER_ENABLED") === "true" &&
    (getConfiguredKey() !== null || relayConfig() !== null)
  );
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return text;
}

function isThrottleError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  if (status !== 400) return false;
  try {
    const parsed = providerErrorSchema.safeParse(JSON.parse(bodyText));
    if (!parsed.success) return false;
    return (
      parsed.data.ErrorCode === 4 ||
      (typeof parsed.data.Message === "string" &&
        parsed.data.Message.includes("ThrottleUser"))
    );
  } catch {
    return false;
  }
}

// Bing throttles per user key, and a throttled key stays throttled while the
// caller keeps hitting it: on tokyo the fleet warm retried 1,600 sites every
// 30 minutes and the key never recovered (ThrottleUser even at one call per
// 2.5 s). Two guards keep the key usable:
// 1. a breaker: after a throttle, no Bing call leaves this isolate for a
//    cool-off, doubling per consecutive throttle up to a ceiling;
// 2. a daily budget per UTC day so one refresh sweep cannot spend the quota.
// Both are per isolate and reset on restart; they bound the damage, not the
// exact provider quota, which Bing does not publish.
const THROTTLE_COOL_OFF_MIN_MS = 15 * 60 * 1000;
const THROTTLE_COOL_OFF_MAX_MS = 4 * 60 * 60 * 1000;
// Observed on tokyo: about 900 two-call refreshes (~1,800 calls) succeed after
// 00:00 UTC before ThrottleUser sets in for the rest of the day.
const DAILY_CALL_BUDGET_DEFAULT = 1_600;

type Guard = {
  blockedUntil: number;
  /** When the breaker last opened; calls admitted before it do not escalate it again. */
  lastThrottleAt: number;
  consecutiveThrottles: number;
  day: string;
  callsToday: number;
};
const guardState: Guard = {
  blockedUntil: 0,
  lastThrottleAt: 0,
  consecutiveThrottles: 0,
  day: "",
  callsToday: 0,
};

function dailyCallBudget(): number {
  const raw = Number(getEnvValueSync(env, "BING_WEBMASTER_DAILY_CALL_BUDGET"));
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DAILY_CALL_BUDGET_DEFAULT;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Throws RATE_LIMITED without a network call while the key must rest.
 * Returns the admission time so a late throttle from a call that was already
 * in flight when the breaker opened does not open it a second time.
 */
function admitCall(now = Date.now()): number {
  if (now < guardState.blockedUntil) {
    const minutes = Math.ceil((guardState.blockedUntil - now) / 60_000);
    throw new AppError(
      "RATE_LIMITED",
      `Bing throttled this key; resting ${minutes} min before the next call`,
    );
  }
  const day = utcDay(now);
  if (guardState.day !== day) {
    guardState.day = day;
    guardState.callsToday = 0;
  }
  if (guardState.callsToday >= dailyCallBudget()) {
    throw new AppError(
      "RATE_LIMITED",
      `Bing daily call budget (${dailyCallBudget()}) used; resumes after 00:00 UTC`,
    );
  }
  guardState.callsToday += 1;
  return now;
}

function noteThrottled(admittedAt: number, now = Date.now()): void {
  // The warm runs a few Bing calls at once; when all of them come back
  // throttled they are one event, not three.
  if (admittedAt < guardState.lastThrottleAt) return;
  guardState.lastThrottleAt = now;
  guardState.consecutiveThrottles += 1;
  const coolOff = Math.min(
    THROTTLE_COOL_OFF_MAX_MS,
    THROTTLE_COOL_OFF_MIN_MS * 2 ** (guardState.consecutiveThrottles - 1),
  );
  guardState.blockedUntil = now + coolOff;
  console.warn("[bing] throttled; pausing Bing calls", {
    coolOffMinutes: Math.round(coolOff / 60_000),
    consecutiveThrottles: guardState.consecutiveThrottles,
    callsToday: guardState.callsToday,
  });
}

function noteSucceeded(): void {
  guardState.consecutiveThrottles = 0;
}

/** Test seam: forget breaker and budget state. */
function resetGuardForTests(): void {
  guardState.blockedUntil = 0;
  guardState.lastThrottleAt = 0;
  guardState.consecutiveThrottles = 0;
  guardState.day = "";
  guardState.callsToday = 0;
}

/** Current guard state, for status pages and logs. */
function guardStatus(now = Date.now()) {
  return {
    pausedUntil:
      now < guardState.blockedUntil
        ? new Date(guardState.blockedUntil).toISOString()
        : null,
    consecutiveThrottles: guardState.consecutiveThrottles,
    callsToday: guardState.day === utcDay(now) ? guardState.callsToday : 0,
    dailyCallBudget: dailyCallBudget(),
  };
}

async function read<T>(
  method: "GetUserSites" | "GetRankAndTrafficStats" | "GetCrawlStats",
  schema: z.ZodType<T>,
  siteUrl?: string,
): Promise<T> {
  const apiKey = getConfiguredKey();
  const relay = relayConfig();
  if (!apiKey && !relay) throw new AppError("FORBIDDEN");
  const admittedAt = admitCall();
  try {
    // Official JSON/HTTP protocol: learn.microsoft.com/en-us/bingwebmaster/api-protocols
    // Direct Worker fetch to ssl.bing.com returns ErrorCode 17 ThrottleIP
    // (shared Cloudflare egress). When a relay is configured, the Worker
    // posts method + params (never the API key) to that HTTPS endpoint.
    let response: Response;
    if (relay) {
      response = await fetch(relay.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${relay.secret}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method,
          params: siteUrl ? { siteUrl } : {},
        }),
        // Workers rejects "error"; "manual" avoids forwarding the secret on redirects.
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } else {
      const url = new URL(
        `https://ssl.bing.com/webmaster/api.svc/json/${method}`,
      );
      url.searchParams.set("apikey", apiKey!);
      if (siteUrl) url.searchParams.set("siteUrl", siteUrl);
      response = await fetch(url, {
        method: "GET",
        // Workers rejects "error"; "manual" avoids forwarding the key on redirects.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!response.ok) {
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError("RATE_LIMITED");
      }
      let kind: string | undefined;
      if (response.status === 400) {
        const errText = await readBoundedText(response).catch(() => "");
        if (isThrottleError(response.status, errText)) {
          throw new AppError("RATE_LIMITED");
        }
        try {
          const parsed = providerErrorSchema.safeParse(JSON.parse(errText));
          if (
            parsed.success &&
            (parsed.data.ErrorCode === 17 ||
              (typeof parsed.data.Message === "string" &&
                parsed.data.Message.includes("ThrottleIP")))
          ) {
            kind = "ThrottleIP";
          }
        } catch {
          /* ignore unparseable 400 bodies */
        }
      }
      console.warn("[bing] webmaster request failed", {
        method,
        status: response.status,
        ...(kind ? { kind } : {}),
      });
      throw new Error("BING_STATUS");
    }
    const text = await readBoundedText(response);
    let parsed: T;
    try {
      parsed = schema.parse(JSON.parse(text));
    } catch {
      console.warn("[bing] webmaster response failed schema or JSON parse", {
        method,
        bytes: text.length,
      });
      throw new Error("BING_PARSE");
    }
    noteSucceeded();
    return parsed;
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") {
      noteThrottled(admittedAt);
      throw error;
    }
    if (error instanceof Error && error.message !== "BING_STATUS" && error.message !== "BING_PARSE") {
      // Never log message/cause: fetch errors can contain the key-bearing URL.
      console.warn("[bing] webmaster request failed", {
        method,
        name: error.name,
      });
    }
    throw new AppError("UPSTREAM_UNAVAILABLE");
  }
}

async function getUserSites() {
  return (await read("GetUserSites", sitesSchema)).d.map((site) => ({
    url: site.Url,
    isVerified: site.IsVerified,
  }));
}

async function getRankAndTrafficStats(siteUrl: string) {
  return (
    await read("GetRankAndTrafficStats", performanceSchema, siteUrl)
  ).d.map((row) => ({
    ...row.Date,
    clicks: row.Clicks,
    impressions: row.Impressions,
  }));
}

async function getCrawlStats(siteUrl: string) {
  return (await read("GetCrawlStats", crawlSchema, siteUrl)).d.map((row) => ({
    ...row.Date,
    allOtherCodes: row.AllOtherCodes,
    blockedByRobotsTxt: row.BlockedByRobotsTxt,
    code2xx: row.Code2xx,
    code301: row.Code301,
    code302: row.Code302,
    code4xx: row.Code4xx,
    code5xx: row.Code5xx,
    containsMalware: row.ContainsMalware,
    crawlErrors: row.CrawlErrors,
    crawledPages: row.CrawledPages,
    inIndex: row.InIndex,
    inLinks: row.InLinks,
    ...(row.ConnectionTimeout === undefined
      ? {}
      : { connectionTimeout: row.ConnectionTimeout }),
    ...(row.DnsFailures === undefined ? {} : { dnsFailures: row.DnsFailures }),
  }));
}

export const BingWebmasterClient = {
  isAvailable,
  getUserSites,
  getRankAndTrafficStats,
  getCrawlStats,
  guardStatus,
  resetGuardForTests,
} as const;
