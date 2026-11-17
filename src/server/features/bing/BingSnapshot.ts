import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const datedRow = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  timestamp: z.iso.datetime(),
  utcOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
});
const performanceRow = datedRow
  .extend({ clicks: count, impressions: count })
  .strict();
const crawlRow = datedRow
  .extend({
    allOtherCodes: count,
    blockedByRobotsTxt: count,
    code2xx: count,
    code301: count,
    code302: count,
    code4xx: count,
    code5xx: count,
    containsMalware: count,
    crawlErrors: count,
    crawledPages: count,
    inIndex: count,
    inLinks: count,
    connectionTimeout: count.optional(),
    dnsFailures: count.optional(),
  })
  .strict();

export const bingSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("bing-webmaster"),
    projectId: z.string().min(1).max(255),
    organizationId: z.string().min(1).max(255),
    bindingId: z.string().uuid(),
    siteUrl: z.string().url().max(2048),
    fetchedAt: z.iso.datetime(),
    /** When the crawl rows were fetched; absent on snapshots written before crawl reuse. */
    crawlFetchedAt: z.iso.datetime().optional(),
    performance: z.array(performanceRow).max(1000),
    crawl: z.array(crawlRow).max(1000),
    scope: z
      .object({
        aggregation: z.literal("daily"),
        performanceSurfaces: z.literal("combined Bing surfaces"),
        timezone: z.null(),
        window: z.literal("provider-returned dates"),
        comparableToGoogleSearchConsole: z.literal(false),
      })
      .strict(),
    limitations: z.array(z.string().max(500)).max(20),
  })
  .strict();

export type BingSnapshot = z.infer<typeof bingSnapshotSchema>;
