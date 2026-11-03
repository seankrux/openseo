/**
 * Deterministic review-only planning from existing GSC + GA4 observations.
 * The score is the source service's within-project relative priority, never
 * a traffic forecast, causal attribution or estimated return.
 */
type NonNegativeMetric = number;

export type SearchOpportunityRow = {
  page: string;
  normalizedPage: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  score: number | null;
  joinStatus: "joined" | "gsc_only";
  scoreComponents: {
    demand: number;
    businessValue: number;
    reachability: number;
  } | null;
  ga4: {
    sessions: number;
    keyEvents: number;
    sessionKeyEventRate: number;
  } | null;
};

export type SearchOpportunitySource = {
  source: {
    searchConsoleSiteUrl: string;
    googleAnalyticsPropertyId: string;
    googleAnalyticsPropertyDisplayName: string | null;
  };
  request: { dateRange: { startDate: string; endDate: string } };
  rows: SearchOpportunityRow[];
  totalCandidateRows: number;
  coverage: { matchedRows: number; unmatchedGscRows: number };
  scoring: {
    formula: string;
    scoreDataLimited: boolean;
    businessValueMetric: string;
  };
  truncated: { gsc: boolean; ga4: boolean; candidates: boolean };
  warnings?: string[];
};

export type SeoExecutionAction = {
  id: string;
  page: string;
  title: string;
  nextStep: string;
  rationale: string;
  category: "snippet_review" | "content_relevance" | "measurement";
  priority: "high" | "medium" | "low" | "needs_data";
  confidence: "gsc_ga4" | "gsc_only" | "not_scored";
  score: number | null;
  evidence: {
    clicks: NonNegativeMetric;
    impressions: NonNegativeMetric;
    ctr: NonNegativeMetric;
    position: number | null;
    sessions: NonNegativeMetric | null;
    keyEvents: NonNegativeMetric | null;
  };
  checklist: string[];
};

export type SeoExecutionPlan = {
  kind: "openseo_execution_plan_v1";
  source: {
    period: { startDate: string; endDate: string };
    searchConsoleSiteUrl: string;
    googleAnalyticsPropertyId: string;
    businessValueMetric: string;
    scoreMeaning: string;
  };
  summary: {
    displayed: number;
    totalCandidates: number;
    scored: number;
    measurementGaps: number;
    incomplete: boolean;
    warnings: string[];
  };
  actions: SeoExecutionAction[];
};

export type SeoReviewPacket = {
  kind: "openseo_review_packet_v1";
  reviewOnly: true;
  source: SeoExecutionPlan["source"];
  actions: SeoExecutionAction[];
};

const SHARED_CHECKLIST = [
  "Confirm the search intent and verify every factual claim.",
  "Preserve the URL and canonical unless separately reviewed.",
  "Review proposed changes before publishing.",
  "Snapshot the current page, then compare rendered content after changes.",
  "Verify indexability and keep a rollback path.",
] as const;

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safePosition(value: number): number | null {
  return Number.isFinite(value) && value >= 1 && value <= 100
    ? Math.round(value * 10) / 10
    : null;
}

function toAction(row: SearchOpportunityRow): SeoExecutionAction {
  const position = safePosition(row.position);
  const score =
    row.joinStatus === "joined" &&
    row.ga4 !== null &&
    position !== null &&
    row.score !== null &&
    Number.isFinite(row.score)
      ? Math.max(0, Math.min(100, Math.round(row.score)))
      : null;
  const measured = row.ga4 !== null;
  const evidence = {
    clicks: nonNegative(row.clicks),
    impressions: nonNegative(row.impressions),
    ctr: Number.isFinite(row.ctr) ? Math.min(1, Math.max(0, row.ctr)) : 0,
    position,
    sessions: measured ? nonNegative(row.ga4!.sessions) : null,
    keyEvents: measured ? nonNegative(row.ga4!.keyEvents) : null,
  };
  const confidence =
    score !== null ? "gsc_ga4" : measured ? "not_scored" : "gsc_only";
  const priority =
    score === null
      ? "needs_data"
      : score >= 70
        ? "high"
        : score >= 40
          ? "medium"
          : "low";
  const category =
    score === null
      ? "measurement"
      : position !== null && position <= 10
        ? "snippet_review"
        : "content_relevance";

  const nextStep =
    category === "measurement"
      ? "Verify the GA4 organic landing-page mapping and metrics before prioritizing content work."
      : category === "snippet_review"
        ? "Review search intent, title/snippet clarity and the page's answer to the target query."
        : "Review topic coverage, supporting evidence and relevant internal links.";

  const checklist =
    category === "measurement"
      ? [
          "Verify the connected GA4 property and its organic traffic coverage.",
          "Check that landing-page hostnames, paths and consent settings align with Search Console.",
          "Do not interpret missing GA4 rows as zero conversions.",
        ]
      : [...SHARED_CHECKLIST];

  const rationale =
    `GSC: ${evidence.impressions} impressions, ${evidence.clicks} clicks` +
    (position === null
      ? ", position unavailable."
      : `, average position ${position}.`) +
    (measured
      ? ` GA4: ${evidence.sessions} organic sessions, ${evidence.keyEvents} key events.`
      : " No matching GA4 landing-page row; business value is unknown.");

  return {
    id: row.normalizedPage || row.page,
    page: row.page,
    title:
      category === "measurement"
        ? "Resolve measurement gap"
        : category === "snippet_review"
          ? "Improve search result and on-page answer"
          : "Strengthen page relevance and internal linking",
    nextStep,
    rationale,
    category,
    priority,
    confidence,
    score,
    evidence,
    checklist,
  };
}

export function buildSeoExecutionPlan(
  source: SearchOpportunitySource,
): SeoExecutionPlan {
  const actions = source.rows.map(toAction);
  actions.sort(
    (a, b) =>
      (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score) ||
      b.evidence.impressions - a.evidence.impressions ||
      a.page.localeCompare(b.page),
  );
  const warnings: string[] = [];
  if (source.truncated.gsc)
    warnings.push("Search Console rows hit the fetch limit.");
  if (source.truncated.ga4) warnings.push("GA4 rows were truncated.");
  if (source.truncated.candidates)
    warnings.push("Only part of the candidate queue is displayed.");
  if (source.scoring.scoreDataLimited)
    warnings.push("GA4 reports indicate limited data.");
  for (const warning of source.warnings ?? []) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }

  return {
    kind: "openseo_execution_plan_v1",
    source: {
      period: { ...source.request.dateRange },
      searchConsoleSiteUrl: source.source.searchConsoleSiteUrl,
      googleAnalyticsPropertyId: source.source.googleAnalyticsPropertyId,
      businessValueMetric: source.scoring.businessValueMetric,
      scoreMeaning:
        "Relative within-project priority, not an ROI or traffic forecast.",
    },
    summary: {
      displayed: actions.length,
      totalCandidates: source.totalCandidateRows,
      scored: actions.filter((action) => action.score !== null).length,
      measurementGaps: actions.filter((action) => action.score === null).length,
      incomplete: warnings.length > 0,
      warnings,
    },
    actions,
  };
}

/** Export genuine plan actions in canonical order; never accept client-supplied action objects. */
export function buildSeoReviewPacket(
  plan: SeoExecutionPlan,
  selectedIds: readonly string[],
): SeoReviewPacket {
  const ids = new Set(selectedIds);
  return {
    kind: "openseo_review_packet_v1",
    reviewOnly: true,
    source: plan.source,
    actions: plan.actions.filter((action) => ids.has(action.id)),
  };
}
