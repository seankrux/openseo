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

function getConfiguredKey(): string | null {
  const apiKey = getEnvValueSync(env, "BING_WEBMASTER_API_KEY");
  return getEnvValueSync(env, "BING_WEBMASTER_ENABLED") === "true" &&
    apiKey?.trim()
    ? apiKey
    : null;
}

function isAvailable(): boolean {
  return getConfiguredKey() !== null;
}

async function read<T>(
  method: "GetUserSites" | "GetRankAndTrafficStats" | "GetCrawlStats",
  schema: z.ZodType<T>,
  siteUrl?: string,
): Promise<T> {
  const apiKey = getConfiguredKey();
  if (!apiKey) throw new AppError("FORBIDDEN");
  try {
    // Official JSON/HTTP protocol: learn.microsoft.com/en-us/bingwebmaster/api-protocols
    const url = new URL(
      `https://ssl.bing.com/webmaster/api.svc/json/${method}`,
    );
    url.searchParams.set("apikey", apiKey);
    if (siteUrl) url.searchParams.set("siteUrl", siteUrl);
    const response = await fetch(url, {
      method: "GET",
      // Workers rejects "error"; "manual" avoids forwarding the key on redirects.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
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
    return schema.parse(JSON.parse(text));
  } catch {
    // Never retain a cause: fetch/JSON errors can contain the key-bearing URL or body.
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
} as const;
