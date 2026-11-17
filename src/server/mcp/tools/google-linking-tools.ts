// CityThrive fork: stable GSC/GA4 linking tools (see GoogleLinkingService).
import { z } from "zod";
import { mcpResponse } from "@/server/mcp/formatters";
import { type ToolContext } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { projectIdSchema } from "@/server/mcp/schemas";
import { GoogleLinkingService } from "@/server/features/google-linking/GoogleLinkingService";

const looseOut = z.looseObject({ ...optionalMetaOutputSchema });
const kindSchema = z.enum(["gsc", "ga4", "both"]);

function errResponse(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return mcpResponse({ text: `Error: ${message}`, structuredContent: { ok: false, error: message } });
}

export const listGooglePropertiesTool = {
  name: "list_google_properties",
  config: {
    title: "List Google properties (GSC sites + GA4 properties)",
    description:
      "Lists every Search Console site and GA4 property visible to each connected Google login, with the accountId to pass to link_gsc_property / link_ga4_property. Set includeStreams to also return GA4 web-stream hosts and measurement IDs (slower: one API call per property). Uses no credits.",
    inputSchema: {
      kind: kindSchema.optional().describe("gsc, ga4 or both (default both)."),
      includeStreams: z.boolean().optional().describe("GA4: include data stream hosts/measurement IDs. Default false."),
    },
    outputSchema: looseOut,
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  },
  handler: async (args: { kind?: "gsc" | "ga4" | "both"; includeStreams?: boolean }, context: ToolContext) => {
    try {
      const r = await GoogleLinkingService.listGoogleProperties({
        userId: context.auth.userId,
        kind: args.kind ?? "both",
        includeStreams: args.includeStreams ?? false,
      });
      const lines: string[] = [];
      if (r.gsc) {
        lines.push(`GSC: ${r.gsc.sites.length} sites`);
        for (const a of r.gsc.accounts) lines.push(`  login ${a.email ?? "?"} accountId=${a.accountId} sites=${a.siteCount}${a.requiresReconnect ? " (RECONNECT NEEDED)" : ""}`);
      }
      if (r.ga4) {
        lines.push(`GA4: ${r.ga4.properties.length} properties`);
        for (const a of r.ga4.accounts) lines.push(`  login ${a.email ?? "?"} accountId=${a.accountId} properties=${a.propertyCount}${a.requiresReconnect ? " (RECONNECT NEEDED)" : ""}`);
      }
      lines.push("Full lists are in structuredContent.");
      return mcpResponse({ text: lines.join("\n"), structuredContent: { ok: true, ...r } });
    } catch (e) {
      return errResponse(e);
    }
  },
};

export const linkGscPropertyTool = {
  name: "link_gsc_property",
  config: {
    title: "Link a Search Console property to a project",
    description:
      "Links one verified Search Console property (siteUrl exactly as GSC lists it, e.g. 'sc-domain:example.com') to a project. accountId is optional: when omitted, the first connected Google login with verified access is used. Replaces any existing GSC link for that project.",
    inputSchema: {
      projectId: projectIdSchema,
      siteUrl: z.string().min(1),
      accountId: z.string().min(1).optional(),
    },
    outputSchema: looseOut,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  },
  handler: async (args: { projectId: string; siteUrl: string; accountId?: string }, context: ToolContext) => {
    try {
      const row = await GoogleLinkingService.linkGsc({ ...args, userId: context.auth.userId, organizationId: context.auth.organizationId });
      return mcpResponse({
        text: `Linked GSC ${row.siteUrl} to ${args.projectId} via ${row.connectedAccountEmail ?? row.gscAccountId}.`,
        structuredContent: { ok: true, projectId: args.projectId, siteUrl: row.siteUrl, accountId: row.gscAccountId, email: row.connectedAccountEmail },
      });
    } catch (e) {
      return errResponse(e);
    }
  },
};

export const linkGa4PropertyTool = {
  name: "link_ga4_property",
  config: {
    title: "Link a GA4 property to a project",
    description:
      "Links one GA4 property ('properties/123' or '123') to a project. accountId is optional: when omitted, the first connected Google login that can see the property is used. Replaces any existing GA4 link for that project.",
    inputSchema: {
      projectId: projectIdSchema,
      propertyId: z.string().min(1),
      accountId: z.string().min(1).optional(),
    },
    outputSchema: looseOut,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  },
  handler: async (args: { projectId: string; propertyId: string; accountId?: string }, context: ToolContext) => {
    try {
      const row = await GoogleLinkingService.linkGa4({ ...args, userId: context.auth.userId, organizationId: context.auth.organizationId });
      return mcpResponse({
        text: `Linked GA4 ${row.propertyId} (${row.propertyDisplayName}) to ${args.projectId} via ${row.connectedAccountEmail ?? row.ga4AccountId}.`,
        structuredContent: { ok: true, projectId: args.projectId, propertyId: row.propertyId, displayName: row.propertyDisplayName, accountId: row.ga4AccountId, email: row.connectedAccountEmail },
      });
    } catch (e) {
      return errResponse(e);
    }
  },
};

export const autoLinkGooglePropertiesTool = {
  name: "auto_link_google_properties",
  config: {
    title: "Auto-link GSC/GA4 by domain (bulk)",
    description:
      "For every project with a domain (or only projectIds), finds a matching property across ALL connected Google logins and links it. GSC: prefers sc-domain:<domain>, then https://<domain>/, https://www.<domain>/. GA4: matches GA4 web-stream default URI host (or a property display name equal to the domain); when several properties match, ga4OnTie='most_sessions' picks the one with the most sessions in the last 28 days, otherwise it is reported as ambiguous. dryRun defaults to TRUE (report only). overwrite=false keeps existing links. limit caps how many links are written this call.",
    inputSchema: {
      kind: kindSchema.optional().describe("gsc, ga4 or both (default both)."),
      dryRun: z.boolean().optional().describe("Default true: report what would be linked without writing."),
      overwrite: z.boolean().optional().describe("Replace existing links when a better match is found. Default false."),
      projectIds: z.array(z.string().min(1)).max(5000).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      ga4OnTie: z.enum(["skip", "most_sessions"]).optional().describe("Default most_sessions."),
      verbose: z.boolean().optional().describe("Include already_linked/no_match rows in the text output. Default false."),
    },
    outputSchema: looseOut,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
  },
  handler: async (
    args: { kind?: "gsc" | "ga4" | "both"; dryRun?: boolean; overwrite?: boolean; projectIds?: string[]; limit?: number; ga4OnTie?: "skip" | "most_sessions"; verbose?: boolean },
    context: ToolContext,
  ) => {
    try {
      const dryRun = args.dryRun ?? true;
      const r = await GoogleLinkingService.autoLink({
        userId: context.auth.userId,
        organizationId: context.auth.organizationId,
        kind: args.kind ?? "both",
        dryRun,
        overwrite: args.overwrite ?? false,
        projectIds: args.projectIds,
        limit: args.limit,
        ga4OnTie: args.ga4OnTie ?? "most_sessions",
      });
      const shown = r.rows.filter((x) => args.verbose || !["already_linked", "no_match"].includes(x.action));
      const lines = [
        `${dryRun ? "DRY RUN. " : ""}Summary: ${JSON.stringify(r.summary)}`,
        ...shown.slice(0, 400).map((x) => `${x.kind} ${x.action} ${x.domain} ${x.target ?? ""}${x.candidates ? ` candidates=${x.candidates.join(",")}` : ""}${x.error ? ` error=${x.error}` : ""}`),
      ];
      if (shown.length > 400) lines.push(`... ${shown.length - 400} more rows in structuredContent`);
      return mcpResponse({ text: lines.join("\n"), structuredContent: { ok: true, dryRun, ...r } });
    } catch (e) {
      return errResponse(e);
    }
  },
};
