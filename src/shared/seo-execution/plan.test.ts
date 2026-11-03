import { describe, expect, it } from "vitest";
import { buildSeoExecutionPlan, buildSeoReviewPacket } from "./plan";
import type { SearchOpportunitySource } from "./plan";

const source: SearchOpportunitySource = {
  request: { dateRange: { startDate: "2026-10-01", endDate: "2026-10-28" } },
  source: {
    searchConsoleSiteUrl: "https://example.com/",
    googleAnalyticsPropertyId: "properties/123",
    googleAnalyticsPropertyDisplayName: "Example GA4",
  },
  totalCandidateRows: 3,
  coverage: { matchedRows: 2, unmatchedGscRows: 1 },
  scoring: {
    formula: "within-project relative score",
    scoreDataLimited: false,
    businessValueMetric: "sessionKeyEventRate",
  },
  truncated: { gsc: false, ga4: false, candidates: false },
  rows: [
    {
      page: "https://example.com/mid",
      normalizedPage: "example.com/mid",
      impressions: 500,
      clicks: 5,
      ctr: 0.01,
      position: 12,
      score: 55,
      joinStatus: "joined",
      scoreComponents: { demand: 0.6, businessValue: 0.4, reachability: 0.5 },
      ga4: { sessions: 31, keyEvents: 2, sessionKeyEventRate: 0.065 },
    },
    {
      page: "https://example.com/high",
      normalizedPage: "example.com/high",
      impressions: 900,
      clicks: 40,
      ctr: 0.0444,
      position: 7,
      score: 82,
      joinStatus: "joined",
      scoreComponents: { demand: 0.9, businessValue: 0.8, reachability: 0.75 },
      ga4: { sessions: 110, keyEvents: 8, sessionKeyEventRate: 0.073 },
    },
    {
      page: "https://example.com/unmatched",
      normalizedPage: "example.com/unmatched",
      impressions: 1500,
      clicks: 20,
      ctr: 0.0133,
      position: 6,
      score: null,
      joinStatus: "gsc_only",
      scoreComponents: null,
      ga4: null,
    },
  ],
};

describe("SEO execution planner", () => {
  it("ranks scored actions using observed GSC and GA4 without forecasting ROI", () => {
    const plan = buildSeoExecutionPlan(source);
    expect(plan.actions.map((action) => action.page)).toEqual([
      "https://example.com/high",
      "https://example.com/mid",
      "https://example.com/unmatched",
    ]);
    expect(plan.actions[0]).toMatchObject({
      priority: "high",
      score: 82,
      confidence: "gsc_ga4",
      evidence: {
        impressions: 900,
        clicks: 40,
        position: 7,
        sessions: 110,
        keyEvents: 8,
      },
    });
    expect(plan.actions[0]?.checklist).toContain(
      "Review proposed changes before publishing.",
    );
    expect(JSON.stringify(plan)).not.toMatch(
      /estimatedRevenue|predictedClicks|guarantee/i,
    );
  });

  it("keeps unmatched GSC pages as explicit measurement gaps", () => {
    const plan = buildSeoExecutionPlan(source);
    expect(plan.actions[2]).toMatchObject({
      confidence: "gsc_only",
      priority: "needs_data",
      score: null,
      evidence: { sessions: null, keyEvents: null },
    });
    expect(plan.actions[2]?.nextStep).toContain(
      "Verify the GA4 organic landing-page mapping",
    );
    expect(plan.summary).toMatchObject({
      scored: 2,
      measurementGaps: 1,
      displayed: 3,
      totalCandidates: 3,
      incomplete: false,
    });
  });

  it("signals incomplete inputs and limited analytics without hiding candidates", () => {
    const plan = buildSeoExecutionPlan({
      ...source,
      scoring: { ...source.scoring, scoreDataLimited: true },
      truncated: { gsc: true, ga4: true, candidates: true },
    });
    expect(plan.actions).toHaveLength(3);
    expect(plan.summary.incomplete).toBe(true);
    expect(plan.summary.warnings).toEqual(
      expect.arrayContaining([
        "Search Console rows hit the fetch limit.",
        "GA4 rows were truncated.",
        "Only part of the candidate queue is displayed.",
        "GA4 reports indicate limited data.",
      ]),
    );
  });

  it("sanitizes non-finite metrics instead of making numerical claims", () => {
    const bad = {
      ...source.rows[0]!,
      clicks: Number.NaN,
      impressions: -8,
      ctr: Number.POSITIVE_INFINITY,
      position: Number.NaN,
      score: Number.NaN,
      ga4: { sessions: -1, keyEvents: Number.NaN, sessionKeyEventRate: 0 },
    };
    const plan = buildSeoExecutionPlan({ ...source, rows: [bad] });
    expect(plan.actions[0]).toMatchObject({
      priority: "needs_data",
      score: null,
      evidence: {
        clicks: 0,
        impressions: 0,
        ctr: 0,
        position: null,
        sessions: 0,
        keyEvents: 0,
      },
    });
  });

  it("builds a deterministic approved-for-review packet containing selected genuine actions only", () => {
    const plan = buildSeoExecutionPlan(source);
    const packet = buildSeoReviewPacket(plan, [
      plan.actions[2]!.id,
      "forged-action",
      plan.actions[0]!.id,
      plan.actions[0]!.id,
    ]);
    expect(packet.kind).toBe("openseo_review_packet_v1");
    expect(packet.reviewOnly).toBe(true);
    expect(packet.actions.map((action) => action.page)).toEqual([
      "https://example.com/high",
      "https://example.com/unmatched",
    ]);
    expect(packet.source).toMatchObject({
      period: { startDate: "2026-10-01", endDate: "2026-10-28" },
    });
  });
});
