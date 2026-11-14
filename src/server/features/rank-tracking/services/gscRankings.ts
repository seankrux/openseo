// CityThrive fork: free rank tracking from Google Search Console. Average
// position per query for the last 28 days vs the 28 days before, from the
// project's connected GSC property. Real GSC data, cached 12h in R2.
import { GscService } from "@/server/features/gsc/services/GscService";
import { windows } from "@/server/features/portfolio/PortfolioService";
import { getCached, setCached } from "@/server/lib/r2-cache";

export type GscRankingRow = {
  query: string;
  position: number;
  prevPosition: number | null;
  clicks: number;
  impressions: number;
};

export type GscRankings = {
  connected: boolean;
  siteUrl?: string;
  window?: { curStart: string; end: string; prevStart: string; prevEnd: string };
  rows: GscRankingRow[];
  fetchedAt: string;
  error?: string;
};

const TTL = 12 * 3600;

async function byQuery(projectId: string, startDate: string, endDate: string) {
  const res = await GscService.getPerformance({
    projectId,
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: 500,
  } as Parameters<typeof GscService.getPerformance>[0]);
  return res;
}

export async function getGscRankings(projectId: string, refresh = false): Promise<GscRankings> {
  const w = windows();
  const key = `gsc-rankings:v1:${projectId}:${w.end}`;
  if (!refresh) {
    const hit = (await getCached(key)) as GscRankings | null;
    if (hit) return hit;
  }
  const fetchedAt = new Date().toISOString();
  try {
    const cur = await byQuery(projectId, w.curStart, w.end);
    const prev = await byQuery(projectId, w.prevStart, w.prevEnd);
    const prevPos = new Map(prev.rows.map((r) => [r.keys?.[0] ?? "", r.position]));
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
    const out: GscRankings = { connected: true, siteUrl: cur.siteUrl, window: w, rows, fetchedAt };
    await setCached(key, out, TTL);
    return out;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notConnected = /not connected|NotConnected/i.test(message) || (error as { name?: string })?.name === "GscNotConnectedError";
    return { connected: !notConnected, rows: [], fetchedAt, error: message.slice(0, 200) };
  }
}
