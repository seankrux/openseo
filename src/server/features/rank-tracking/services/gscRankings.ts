import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { z } from "zod";
// CityThrive fork: free rank tracking from Google Search Console. Average
// position per query for the last 28 days vs the 28 days before, from the
// project's connected GSC property. Real GSC data, cached 12h in R2.
import { GscService } from "@/server/features/gsc/services/GscService";
import { windows } from "@/server/features/portfolio/PortfolioService";
import { getCached, setCached } from "@/server/lib/r2-cache";

const rankingsSchema = z.object({
  connected: z.boolean(),
  siteUrl: z.string().optional(),
  window: z
    .object({
      curStart: z.string(),
      end: z.string(),
      prevStart: z.string(),
      prevEnd: z.string(),
    })
    .optional(),
  rows: z.array(
    z.object({
      query: z.string(),
      position: z.number(),
      prevPosition: z.number().nullable(),
      clicks: z.number(),
      impressions: z.number(),
    }),
  ),
  fetchedAt: z.string(),
  error: z.string().optional(),
});
type GscRankings = z.infer<typeof rankingsSchema>;

const TTL = 12 * 3600;

async function byQuery(projectId: string, startDate: string, endDate: string) {
  const res = await GscService.getPerformance({
    projectId,
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: 500,
  });
  return res;
}

export async function getGscRankings(
  projectId: string,
  refresh = false,
): Promise<GscRankings> {
  const w = windows();
  const fetchedAt = new Date().toISOString();
  try {
    const connection = await GscConnectionRepository.getByProjectId(projectId);
    if (!connection) return { connected: false, rows: [], fetchedAt };
    const key = `gsc-rankings:v2:${projectId}:${encodeURIComponent(JSON.stringify([connection.siteUrl, connection.connectedByUserId, connection.gscAccountId, connection.updatedAt]))}:${w.end}`;
    if (!refresh) {
      const hit = rankingsSchema.safeParse(await getCached(key));
      if (hit.success) return hit.data;
    }
    const cur = await byQuery(projectId, w.curStart, w.end);
    const prev = await byQuery(projectId, w.prevStart, w.prevEnd);
    const prevPos = new Map(
      prev.rows.map((r) => [r.keys?.[0] ?? "", r.position]),
    );
    const rows = cur.rows
      .map((r) => {
        const q = r.keys?.[0] ?? "";
        return {
          query: q,
          position: r.position,
          prevPosition: prevPos.get(q) ?? null,
          clicks: r.clicks,
          impressions: r.impressions,
        };
      })
      .filter((r) => r.query);
    const out: GscRankings = {
      connected: true,
      siteUrl: cur.siteUrl,
      window: w,
      rows,
      fetchedAt,
    };
    await setCached(key, out, TTL);
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notConnected =
      /not connected|NotConnected/i.test(message) ||
      (error instanceof Error && error.name === "GscNotConnectedError");
    return {
      connected: !notConnected,
      rows: [],
      fetchedAt,
      error: message.slice(0, 200),
    };
  }
}
