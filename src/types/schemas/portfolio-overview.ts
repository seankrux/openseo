import { z } from "zod";

export const portfolioOverviewSearchSchema = z
  .object({
    filter: z.string().optional().catch(undefined),
    coverage: z
      .enum([
        "all",
        "gscYes",
        "gscNo",
        "ga4Yes",
        "ga4No",
        "ga4Zero",
        "noGoogle",
        "noAudit",
        "critical",
      ])
      .optional()
      .catch(undefined),
    sort: z
      .enum([
        "name",
        "clicks",
        "clicksDelta",
        "impressions",
        "impressionsDelta",
        "position",
        "positionDelta",
        "sessions",
        "sessionsDelta",
        "users",
        "critical",
        "lastAudit",
        "lighthouseSeo",
      ])
      .optional()
      .catch(undefined),
    order: z.enum(["asc", "desc"]).optional().catch(undefined),
  })
  .passthrough();

export type PortfolioOverviewSearch = z.infer<
  typeof portfolioOverviewSearchSchema
>;
