import {
  StoredGoogleSnapshotService,
  type StoredGscEvidence,
} from "@/server/features/portfolio/StoredGoogleSnapshotService";
import { gscProvenanceSchema } from "./GoogleSnapshotProvenance";

type GscClickDropPreview = {
  id: "gsc-click-drop";
  state: "triggered" | "clear" | "unknown";
  reason: string;
  evidence: StoredGscEvidence;
  dropPercent: number | null;
};

function evaluate(
  evidence: StoredGscEvidence,
  input: { projectId: string; organizationId: string },
): GscClickDropPreview {
  const unknown: GscClickDropPreview = {
    id: "gsc-click-drop",
    state: "unknown",
    reason:
      "Stored GSC evidence does not meet freshness, scope, completeness or minimum-volume requirements.",
    evidence,
    dropPercent: null,
  };
  const parsed = gscProvenanceSchema.safeParse(evidence.provenance);
  if (
    evidence.status !== "available" ||
    !parsed.success ||
    !evidence.current ||
    !evidence.previous ||
    !evidence.periods ||
    !evidence.fetchedAt
  )
    return unknown;
  const provenance = parsed.data;
  const age = Date.now() - Date.parse(evidence.fetchedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 12 * 60 * 60 * 1000 ||
    provenance.projectId !== input.projectId ||
    provenance.organizationId !== input.organizationId ||
    provenance.property !== evidence.property ||
    provenance.request.dataState !== "final" ||
    !provenance.quality.complete
  )
    return unknown;
  if (
    evidence.periods.current.startDate !==
      provenance.periods.current.startDate ||
    evidence.periods.current.endDate !== provenance.periods.current.endDate ||
    evidence.periods.previous.startDate !==
      provenance.periods.previous.startDate ||
    evidence.periods.previous.endDate !== provenance.periods.previous.endDate
  )
    return unknown;
  const current = evidence.current.clicks;
  const previous = evidence.previous.clicks;
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(previous) ||
    previous < 50
  )
    return unknown;
  const dropPercent = ((previous - current) * 100) / previous;
  const triggered = current * 100 <= previous * 70;
  return {
    id: "gsc-click-drop",
    state: triggered ? "triggered" : "clear",
    reason: triggered
      ? "GSC clicks fell by at least 30 percent."
      : "GSC clicks did not fall by 30 percent.",
    evidence,
    dropPercent,
  };
}

async function preview(input: { projectId: string; organizationId: string }) {
  // The stored reader authorizes the project before touching either source.
  const stored = await StoredGoogleSnapshotService.read(input);
  return {
    projectId: input.projectId,
    evaluatedAt: new Date().toISOString(),
    alerts: [evaluate(stored.gsc, input)],
  };
}

export const ProjectAlertService = { preview };
