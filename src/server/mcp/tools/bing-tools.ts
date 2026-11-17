import { z } from "zod";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

export const refreshBingWebmasterSnapshotTool = {
  name: "refresh_bing_webmaster_snapshot",
  config: {
    title: "Refresh Bing Webmaster snapshot",
    description:
      "Explicitly reads performance and crawl statistics for this project's preverified Bing site and saves a private scoped snapshot. Requires server-side opt-in, credential and an owner/admin-verified site binding. Uses fixed read-only Bing endpoints; never submits URLs or calls IndexNow. Provider daily windows and combined Bing surfaces are not Google Search Console-equivalent. Does not configure bindings, credentials or schedules.",
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.looseObject({
      projectId: z.string(),
      siteUrl: z.string(),
      fetchedAt: z.string(),
      performanceRows: z.number(),
      crawlRows: z.number(),
      scope: z.looseObject({
        aggregation: z.string(),
        performanceSurfaces: z.string(),
        timezone: z.null(),
        window: z.string(),
        comparableToGoogleSearchConsole: z.literal(false),
      }),
      limitations: z.array(z.string()),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) => {
    const snapshot = await BingWebmasterService.refreshSnapshot({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
    });
    return mcpResponse({
      text: `Saved Bing snapshot for ${snapshot.siteUrl}, fetched ${snapshot.fetchedAt}: ${snapshot.performance.length} daily performance rows and ${snapshot.crawl.length} crawl rows. No URL submission, IndexNow or scheduling. Bing scope is not directly comparable to Google Search Console.`,
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: {
        projectId: args.projectId,
        siteUrl: snapshot.siteUrl,
        fetchedAt: snapshot.fetchedAt,
        performanceRows: snapshot.performance.length,
        crawlRows: snapshot.crawl.length,
        scope: snapshot.scope,
        limitations: snapshot.limitations,
      },
    });
  }),
};
