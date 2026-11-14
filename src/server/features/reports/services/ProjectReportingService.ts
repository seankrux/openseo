import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { ReportService } from "./ReportService";
import { ProjectHealthRepository } from "../repositories/ProjectHealthRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { loadAiTrend } from "@/server/features/ai-visibility/services/aiVisibilityTrend";
import { StoredGoogleSnapshotService } from "@/server/features/portfolio/StoredGoogleSnapshotService";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";
import { sortBy } from "remeda";

function escapeText(value: string | number | null) {
  return String(value ?? "Unknown")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function generate(input: {
  projectId: string;
  organizationId: string;
  createdBy: string;
  createdByUserId: string;
}) {
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");

  const generatedAt = new Date().toISOString();
  const audit = await ProjectHealthRepository.getLatestCompletedAudit(
    project.id,
  );
  const auditHtml = audit
    ? `<p>Audit ${escapeText(audit.auditId)}: ${escapeText(audit.startUrl)}</p><p>${escapeText(audit.startedAt)} to ${escapeText(audit.completedAt)}</p><p>${escapeText(audit.pagesCrawled)} pages; ${escapeText(audit.criticalIssues)} critical; ${escapeText(audit.warningIssues)} warning; ${escapeText(audit.informationalIssues)} informational issues.</p>`
    : "<p>Unknown: no saved completed audit.</p>";
  const configs = await RankTrackingRepository.getConfigsForProject(project.id);
  const rank = await Promise.all(
    configs.slice(0, 5).map(async (config) => {
      const results = await getLatestResults(config.id, project.id);
      return {
        configId: config.id,
        domain: config.domain,
        locationCode: config.locationCode,
        locationName: config.locationName,
        languageCode: config.languageCode,
        devices: config.devices,
        serpDepth: config.serpDepth,
        run: results.run
          ? {
              id: results.run.id,
              status: results.run.status,
              lastCheckedAt: results.run.lastCheckedAt,
              completedAt: results.run.completedAt,
            }
          : null,
        totalRows: results.rows.length,
        rows: results.rows.slice(0, 50).map((row) => ({
          keyword: row.keyword,
          desktop: row.desktop.position,
          mobile: row.mobile.position,
        })),
      };
    }),
  );
  const rankHtml = rank.length
    ? rank
        .map(
          (tracker) =>
            `<h3>${escapeText(tracker.domain)}</h3><p>Scope: ${escapeText(tracker.locationName)} (${escapeText(tracker.locationCode)}), ${escapeText(tracker.languageCode)}, ${escapeText(tracker.devices)}, saved depth ${escapeText(tracker.serpDepth)}.</p><p>Newest snapshot: ${escapeText(tracker.run?.lastCheckedAt ?? null)}; latest run: ${escapeText(tracker.run?.status ?? null)}, completed ${escapeText(tracker.run?.completedAt ?? null)}.</p><p>Showing ${tracker.rows.length} of ${tracker.totalRows} saved keywords; omitted rows are not represented.</p><ul>${tracker.rows.map((row) => `<li>${escapeText(row.keyword)}: desktop ${escapeText(row.desktop)}, mobile ${escapeText(row.mobile)}</li>`).join("")}</ul>`,
        )
        .join("")
    : "<p>Unknown: no saved rank trackers.</p>";
  const ai = await loadAiTrend({ projectId: project.id, days: 28 });
  const aiChange =
    ai.comparison === "comparable" && ai.mentions.change !== null
      ? `${escapeText(ai.mentions.change)} percentage points`
      : "Change unavailable";
  const aiHtml = `<p>Comparison: ${escapeText(ai.comparison)}. Window: ${escapeText(ai.current.start)} to ${escapeText(ai.current.end)}; previous: ${escapeText(ai.previous.start)} to ${escapeText(ai.previous.end)}.</p><p>Current coverage: ${escapeText(ai.current.coverage.answered)}/${escapeText(ai.current.coverage.expected)} answers; previous coverage: ${escapeText(ai.previous.coverage.answered)}/${escapeText(ai.previous.coverage.expected)} answers.</p><p>Current mention rate: ${escapeText(ai.mentions.current)}${ai.mentions.current === null ? "" : "%"}; current citation rate: ${escapeText(ai.citations.current)}${ai.citations.current === null ? "" : "%"}. ${aiChange}.</p><p>Last saved finished run: ${escapeText(ai.runs.at(-1)?.createdAt ?? null)}. Scope: neutral prompt / engine / market / brand-identity cells. Failed or missing answers are not absent-brand observations; incomplete or changed scopes do not prove a trend.</p>`;
  const google = await StoredGoogleSnapshotService.read({
    projectId: project.id,
    organizationId: input.organizationId,
  });
  const googleHtml = [
    {
      name: "Search Console",
      evidence: google.gsc,
      metrics: `<p>Current: ${escapeText(google.gsc.current?.clicks ?? null)} clicks, ${escapeText(google.gsc.current?.impressions ?? null)} impressions, average position ${escapeText(google.gsc.current?.position ?? null)}. Previous: ${escapeText(google.gsc.previous?.clicks ?? null)} clicks, ${escapeText(google.gsc.previous?.impressions ?? null)} impressions, average position ${escapeText(google.gsc.previous?.position ?? null)}.</p>`,
    },
    {
      name: "Google Analytics 4",
      evidence: google.ga4,
      metrics: `<p>All-channel traffic, not organic leads or revenue. Current: ${escapeText(google.ga4.current?.sessions ?? null)} sessions, ${escapeText(google.ga4.current?.activeUsers ?? null)} active users. Previous: ${escapeText(google.ga4.previous?.sessions ?? null)} sessions, ${escapeText(google.ga4.previous?.activeUsers ?? null)} active users.</p>`,
    },
  ]
    .map(
      ({ name, evidence, metrics }) =>
        `<h3>${name}</h3><p>Status: ${escapeText(evidence.status)}; property: ${escapeText(evidence.property)}; fetched: ${escapeText(evidence.fetchedAt)}.</p><p>Current: ${escapeText(evidence.periods?.current.startDate ?? null)} to ${escapeText(evidence.periods?.current.endDate ?? null)}; previous: ${escapeText(evidence.periods?.previous.startDate ?? null)} to ${escapeText(evidence.periods?.previous.endDate ?? null)}.</p>${metrics}<ul>${evidence.limitations.map((limitation) => `<li>${escapeText(limitation)}</li>`).join("")}</ul>`,
    )
    .join("");
  const bing = await BingWebmasterService.getStoredSnapshot({
    projectId: project.id,
    organizationId: input.organizationId,
  });
  const bingHtml = bing
    ? `<p>Historical saved snapshot; freshness is not assumed. Site: ${escapeText(bing.siteUrl)}; fetched ${escapeText(bing.fetchedAt)}.</p><p>Scope: ${escapeText(bing.scope.performanceSurfaces)}, ${escapeText(bing.scope.aggregation)}, ${escapeText(bing.scope.window)}. Timezone: ${escapeText(bing.scope.timezone)}. This is not directly comparable to Google Search Console.</p><h3>Performance</h3><p>Showing ${Math.min(31, bing.performance.length)} of ${bing.performance.length} saved performance rows, newest by provider timestamp; not a complete period.</p><ul>${sortBy(
        bing.performance,
        [(row) => row.timestamp, "desc"],
      )
        .slice(0, 31)
        .map(
          (row) =>
            `<li>Date ${escapeText(row.date)}; timestamp ${escapeText(row.timestamp)}; UTC offset ${escapeText(row.utcOffsetMinutes)} minutes: ${escapeText(row.clicks)} clicks, ${escapeText(row.impressions)} impressions.</li>`,
        )
        .join(
          "",
        )}</ul><h3>Crawl</h3><p>Showing ${Math.min(31, bing.crawl.length)} of ${bing.crawl.length} saved crawl rows, newest by provider timestamp; not a complete period. Empty rows are unknown observations, not zero traffic or a healthy crawl. In-index values are daily observations, not additive totals.</p><ul>${sortBy(
        bing.crawl,
        [(row) => row.timestamp, "desc"],
      )
        .slice(0, 31)
        .map(
          (row) =>
            `<li>Date ${escapeText(row.date)}; timestamp ${escapeText(row.timestamp)}; UTC offset ${escapeText(row.utcOffsetMinutes)} minutes: ${escapeText(row.crawledPages)} crawled pages, ${escapeText(row.inIndex)} in index, ${escapeText(row.crawlErrors)} crawl errors, ${escapeText(row.code4xx)} 4xx, ${escapeText(row.code5xx)} 5xx, ${escapeText(row.blockedByRobotsTxt)} blocked by robots, ${escapeText(row.containsMalware)} malware.</li>`,
        )
        .join(
          "",
        )}</ul><ul>${bing.limitations.map((limitation) => `<li>${escapeText(limitation)}</li>`).join("")}</ul>`
    : "<p>Unknown: no valid saved snapshot for an active Bing site binding. No provider request was made.</p>";
  const saved = await ReportService.saveReport({
    ...input,
    title: `Project health — ${project.name.slice(0, 24)} — ${generatedAt} — ${crypto.randomUUID()}`,
    summary:
      "Saved evidence only. Missing data is unknown, not a healthy result.",
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Project health</title></head><body><h1>Project health — ${escapeText(project.name)}</h1><p>Generated ${escapeText(generatedAt)}</p><p>Stored data only. No sources were refreshed.</p><h2>Saved technical audit</h2>${auditHtml}<p>Historical crawl evidence, not current site health or CrUX field data. Scope is the saved crawl's start URL; missing data is unknown.</p><h2>Saved rank tracking</h2><p>Showing ${rank.length} of ${configs.length} saved rank trackers; omitted trackers are not represented.</p>${rankHtml}<p>Exact period deltas are unavailable: saved comparison baselines can have different dates. Positions may come from different completed runs; a newer failed run does not refresh them. Null is unknown or outside the saved search depth, never position zero.</p><h2>Saved AI visibility</h2>${aiHtml}<h2>Saved Google evidence</h2>${googleHtml}<p>Only recorded source scope and periods are known. Legacy, stale, failed or unavailable evidence does not prove a healthy result or qualify an alert.</p><h2>Saved Bing Webmaster evidence</h2>${bingHtml}</body></html>`,
    skill: "project-health",
  });
  return { ...saved, generatedAt, evidence: { audit, rank, ai, google, bing } };
}

export const ProjectReportingService = { generate };
