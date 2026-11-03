// CityThrive fork: GA4 setup MCP tools (preview by default; apply needs confirm=true).
import {
  readLog,
  readState,
  runBulk,
  setupSite,
} from "@/server/features/ga4-setup/Ga4SetupService";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

const out = z.looseObject({ ...optionalMetaOutputSchema });
const fail = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  return mcpResponse({
    text: `Error: ${message}`,
    structuredContent: { ok: false, error: message },
  });
};

export const ga4SetupSiteTool = {
  name: "ga4_setup_site",
  config: {
    title:
      "GA4 setup for one site (create property + stream, Cloudflare tag, verify, link)",
    description:
      "Previews (default) or applies GA4 setup for one project: finds or creates the GA4 property and web stream with the connected GA4 login, installs gtag through the Cloudflare injector Worker, verifies the tag on the homepage, and links the property. Applying requires apply=true AND confirm=true.",
    inputSchema: {
      projectId: z.string().min(1),
      apply: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    outputSchema: out,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (
    a: { projectId: string; apply?: boolean; confirm?: boolean },
    c: ToolContext,
  ) => {
    try {
      const apply = !!a.apply && !!a.confirm;
      const r = await setupSite({
        ...c.auth,
        projectId: a.projectId,
        apply,
      });
      const lines = [
        `${r.domain}: ${apply ? "APPLIED" : "PREVIEW"} -> ${r.final}`,
        ...r.steps.map(
          (s) => `  ${s.step}: ${s.status}${s.detail ? " " + s.detail : ""}`,
        ),
      ];
      if (a.apply && !a.confirm)
        lines.push("Not applied: pass confirm=true to apply.");
      return mcpResponse({
        text: lines.join("\n"),
        structuredContent: { ok: true, ...r },
      });
    } catch (e) {
      return fail(e);
    }
  },
};

export const ga4SetupBulkTool = {
  name: "ga4_setup_missing",
  config: {
    title: "GA4 setup for all sites missing GA4 (bulk)",
    description:
      "Runs GA4 setup for up to `limit` projects that have no GA4 link (default 10, max 200). Preview by default; apply needs apply=true AND confirm=true. Skips sites marked blocked and failures still in back-off.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional(),
      projectIds: z.array(z.string()).optional(),
      apply: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
    outputSchema: out,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (
    a: {
      limit?: number;
      projectIds?: string[];
      apply?: boolean;
      confirm?: boolean;
    },
    c: ToolContext,
  ) => {
    try {
      const apply = !!a.apply && !!a.confirm;
      const r = await runBulk({
        ...c.auth,
        apply,
        limit: a.limit ?? 10,
        projectIds: a.projectIds,
      });
      const lines = [
        `${apply ? "APPLIED" : "PREVIEW"}: processed ${r.processed} of ${r.missingTotal} missing GA4`,
        ...r.results.map(
          (x) =>
            `  ${x.domain}: ${x.final} ${x.measurementId ?? ""} ${x.steps
              .filter((s) => s.status === "error" || s.status === "blocked")
              .map((s) => s.detail)
              .join("; ")}`,
        ),
      ];
      return mcpResponse({
        text: lines.join("\n"),
        structuredContent: { ok: true, ...r },
      });
    } catch (e) {
      return fail(e);
    }
  },
};

export const ga4SetupStatusTool = {
  name: "ga4_setup_status",
  config: {
    title: "GA4 setup status",
    description:
      "Per-domain GA4 setup status (created/tagged/live/linked/blocked/error) and the recent log.",
    inputSchema: {},
    outputSchema: out,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (_args: Record<string, never>, c: ToolContext) => {
    try {
      const state = await readState(c.auth);
      const counts: Record<string, number> = {};
      for (const s of Object.values(state))
        counts[s.status] = (counts[s.status] ?? 0) + 1;
      const log = (await readLog(c.auth)).slice(0, 30);
      return mcpResponse({
        text: `${JSON.stringify(counts)}\n${log.join("\n")}`,
        structuredContent: { ok: true, counts, state, log },
      });
    } catch (e) {
      return fail(e);
    }
  },
};
