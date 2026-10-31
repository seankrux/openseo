import { z } from "zod";
import { ProjectAlertService } from "@/server/features/project-alerts/ProjectAlertService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const periodSchema = z.looseObject({
  startDate: z.string(),
  endDate: z.string(),
});

export const previewProjectAlertsTool = {
  name: "preview_project_alerts",
  config: {
    title: "Preview private project alerts",
    description:
      "Evaluates saved evidence only; never refreshes providers, sends alerts or creates schedules. The GSC click-drop rule requires at least a 30% drop, 50 previous clicks, finalized adjacent 28-day windows with identical property/search scope, and evidence no older than 12 hours. Missing, legacy, failed, stale or incomplete scope is unknown—not healthy. This is a private preview, not delivery.",
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.looseObject({
      projectId: z.string(),
      evaluatedAt: z.string(),
      alerts: z.array(
        z.looseObject({
          id: z.literal("gsc-click-drop"),
          state: z.enum(["triggered", "clear", "unknown"]),
          reason: z.string(),
          dropPercent: z.number().nullable(),
          evidence: z.looseObject({
            status: z.string(),
            property: z.string().nullable(),
            fetchedAt: z.string().nullable(),
            periods: z
              .looseObject({ current: periodSchema, previous: periodSchema })
              .nullable(),
            currentClicks: z.number().nullable(),
            previousClicks: z.number().nullable(),
            scope: z.looseObject({
              searchType: z.string().nullable(),
              dataState: z.string().nullable(),
              timeZone: z.string().nullable(),
              windowAnchor: z.string().nullable(),
              complete: z.boolean().nullable(),
            }),
            limitations: z.array(z.string()),
          }),
        }),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) => {
    const preview = await ProjectAlertService.preview({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
    });
    const alerts = preview.alerts.map(({ evidence, ...alert }) => ({
      ...alert,
      evidence: {
        status: evidence.status,
        property: evidence.property,
        fetchedAt: evidence.fetchedAt,
        periods: evidence.periods,
        currentClicks: evidence.current?.clicks ?? null,
        previousClicks: evidence.previous?.clicks ?? null,
        scope: {
          searchType: evidence.provenance?.request.type ?? null,
          dataState: evidence.provenance?.request.dataState ?? null,
          timeZone: evidence.provenance?.dateBasis.timeZone ?? null,
          windowAnchor: evidence.provenance?.dateBasis.windowAnchor ?? null,
          complete: evidence.provenance?.quality.complete ?? null,
        },
        limitations: evidence.limitations,
      },
    }));
    return mcpResponse({
      text: `Private stored-evidence preview: ${alerts.map((alert) => `${alert.id}: ${alert.state}`).join("; ")}. No provider refresh, delivery or schedule.`,
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: {
        projectId: preview.projectId,
        evaluatedAt: preview.evaluatedAt,
        alerts,
      },
    });
  }),
};
