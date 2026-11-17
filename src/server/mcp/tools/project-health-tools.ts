import { z } from "zod";
import { ProjectReportingService } from "@/server/features/reports/services/ProjectReportingService";
import { DEFAULT_CLIENT_LABEL } from "@/server/mcp/client-label";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";

const projectInputSchema = { projectId: projectIdSchema };

export const generateProjectHealthReportTool = {
  name: "generate_project_health_report",
  config: {
    title: "Generate private project health report",
    description:
      "Creates a new private report from stored completed audit, rank, AI, validated Google and Bing evidence. No provider refresh, sharing, delivery or schedule. Missing or unqualified evidence is unknown, not healthy. Returns the report URL; does not update existing reports.",
    inputSchema: projectInputSchema,
    outputSchema: z.looseObject({
      reportId: z.string(),
      title: z.string(),
      created: z.boolean(),
      htmlBytes: z.number(),
      generatedAt: z.string(),
      sharing: z.literal("private"),
      url: z.string(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) => {
    const saved = await ProjectReportingService.generate({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      createdBy: context.auth.clientLabel ?? DEFAULT_CLIENT_LABEL,
      createdByUserId: context.auth.userId,
    });
    const path = `/p/${args.projectId}/reports/${saved.reportId}`;
    const url = buildDashboardUrl(context.baseUrl, path);
    return mcpResponse({
      text: `Saved new private report: ${url}. Stored evidence only; no refresh, sharing, delivery or schedule.`,
      meta: buildProjectMeta(context, args.projectId, path),
      structuredContent: {
        reportId: saved.reportId,
        title: saved.title,
        created: saved.created,
        htmlBytes: saved.htmlBytes,
        generatedAt: saved.generatedAt,
        sharing: "private" as const,
        url,
      },
    });
  }),
};
