import { z } from "zod";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { getCached } from "@/server/lib/r2-cache";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { ga4CacheKey } from "./PortfolioCacheKeys";
import {
  gscProvenanceSchema,
  ga4ProvenanceSchema,
  ga4EvidenceLimitations,
  type StoredGscProvenance,
  type StoredGa4Provenance,
} from "@/server/features/project-alerts/GoogleSnapshotProvenance";

type EvidenceStatus =
  | "available"
  | "legacy"
  | "unavailable"
  | "stale"
  | "failed"
  | "invalid";
type Periods = {
  current: { startDate: string; endDate: string };
  previous: { startDate: string; endDate: string };
};
type Evidence<Metrics, Provenance = never> = {
  status: EvidenceStatus;
  property: string | null;
  fetchedAt: string | null;
  periods: Periods | null;
  limitations: string[];
  current: Metrics | null;
  previous: Metrics | null;
  provenance?: Provenance;
};
export type StoredGscEvidence = Evidence<
  { clicks: number; impressions: number; position: number | null },
  StoredGscProvenance
>;
export type StoredGa4Evidence = Evidence<
  { sessions: number; activeUsers: number },
  StoredGa4Provenance
>;

const count = z.number().finite().nonnegative();
const gscCacheSchema = z.object({
  clicks: count,
  impressions: count,
  position: count.nullable(),
  prevClicks: count,
  prevImpressions: count,
  prevPosition: count.nullable(),
  fetchedAt: z.string().datetime(),
  provenance: gscProvenanceSchema.optional(),
});
function unavailable(): Evidence<never> {
  return {
    status: "unavailable",
    property: null,
    fetchedAt: null,
    periods: null,
    limitations: ["No active connection."],
    current: null,
    previous: null,
  };
}

async function readGsc(input: {
  projectId: string;
  organizationId: string;
}): Promise<StoredGscEvidence> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) return unavailable();
  if (
    connection.projectId !== input.projectId ||
    connection.organizationId !== input.organizationId
  ) {
    return {
      ...unavailable(),
      status: "invalid",
      limitations: ["Connection scope does not match the project."],
    };
  }
  const cached = await getCached(
    `portfolio-gsc:v1:${input.projectId}:${connection.siteUrl}`,
  );
  const currentConnection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (
    !currentConnection ||
    currentConnection.id !== connection.id ||
    currentConnection.projectId !== input.projectId ||
    currentConnection.organizationId !== input.organizationId ||
    currentConnection.siteUrl !== connection.siteUrl ||
    currentConnection.connectedByUserId !== connection.connectedByUserId ||
    currentConnection.gscAccountId !== connection.gscAccountId ||
    currentConnection.updatedAt !== connection.updatedAt
  )
    return {
      ...unavailable(),
      status: "invalid",
      limitations: ["Connection changed while stored evidence was read."],
    };
  if (cached == null)
    return {
      ...unavailable(),
      property: connection.siteUrl,
      limitations: ["Stored evidence is missing or expired."],
    };
  if (typeof cached === "object" && "error" in cached)
    return {
      ...unavailable(),
      status: "failed",
      property: connection.siteUrl,
      limitations: ["The stored collection failed; metrics are unavailable."],
    };
  const parsed = gscCacheSchema.safeParse(cached);
  if (!parsed.success)
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.siteUrl,
      limitations: ["Stored metrics or timestamp are invalid."],
    };
  const data = parsed.data;
  const provenance = data.provenance;
  if (
    provenance &&
    (provenance.projectId !== input.projectId ||
      provenance.organizationId !== input.organizationId ||
      provenance.property !== connection.siteUrl ||
      provenance.binding.id !== connection.id ||
      provenance.binding.userId !== connection.connectedByUserId ||
      provenance.binding.accountId !== connection.gscAccountId ||
      provenance.binding.updatedAt !== connection.updatedAt)
  )
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.siteUrl,
      limitations: [
        "Stored evidence belongs to a different connection or project scope.",
      ],
    };
  const age = Date.now() - Date.parse(data.fetchedAt);
  if (age < 0 || age > 12 * 60 * 60 * 1000)
    return {
      ...unavailable(),
      status: age < 0 ? "invalid" : "stale",
      property: connection.siteUrl,
      fetchedAt: data.fetchedAt,
      limitations: [
        age < 0
          ? "Stored timestamp is in the future."
          : "Stored evidence is older than twelve hours.",
      ],
    };
  if (
    provenance &&
    provenance.periods.current.endDate !==
      new Date(
        Date.parse(data.fetchedAt) - provenance.dateBasis.lagDays * 86400_000,
      )
        .toISOString()
        .slice(0, 10)
  )
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.siteUrl,
      limitations: [
        "Stored periods do not match the recorded UTC collection date and data lag.",
      ],
    };
  const limitations = provenance
    ? [
        provenance.request.dataState === "final"
          ? "Final GSC data was requested; provider finality is not independently confirmed."
          : "Final GSC data was not requested.",
      ]
    : ["Exact periods, finalized request and completeness were not recorded."];
  if (provenance && !provenance.quality.complete)
    limitations.push("Response completeness is unknown.");
  return {
    status: data.provenance ? "available" : "legacy",
    property: connection.siteUrl,
    fetchedAt: data.fetchedAt,
    periods: data.provenance?.periods ?? null,
    ...(data.provenance ? { provenance: data.provenance } : {}),
    limitations,
    current: {
      clicks: data.clicks,
      impressions: data.impressions,
      position: data.position,
    },
    previous: {
      clicks: data.prevClicks,
      impressions: data.prevImpressions,
      position: data.prevPosition,
    },
  };
}

async function readGa4(input: {
  projectId: string;
  organizationId: string;
}): Promise<StoredGa4Evidence> {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) return unavailable();
  if (
    connection.projectId !== input.projectId ||
    connection.organizationId !== input.organizationId
  ) {
    return {
      ...unavailable(),
      status: "invalid",
      limitations: ["Connection scope does not match the project."],
    };
  }
  const schema = z.object({
    sessions: count,
    activeUsers: count,
    prevSessions: count,
    prevActiveUsers: count,
    fetchedAt: z.string().datetime(),
    provenance: ga4ProvenanceSchema.optional(),
  });
  const cached = await getCached(
    ga4CacheKey(input.projectId, connection.propertyId),
  );
  const currentConnection = await Ga4ConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (
    !currentConnection ||
    currentConnection.id !== connection.id ||
    currentConnection.projectId !== input.projectId ||
    currentConnection.organizationId !== input.organizationId ||
    currentConnection.propertyId !== connection.propertyId ||
    currentConnection.connectedByUserId !== connection.connectedByUserId ||
    currentConnection.ga4AccountId !== connection.ga4AccountId ||
    currentConnection.updatedAt !== connection.updatedAt
  )
    return {
      ...unavailable(),
      status: "invalid",
      limitations: ["Connection changed while stored evidence was read."],
    };
  if (cached == null)
    return {
      ...unavailable(),
      property: connection.propertyId,
      limitations: ["Stored evidence is missing or expired."],
    };
  if (typeof cached === "object" && "error" in cached)
    return {
      ...unavailable(),
      status: "failed",
      property: connection.propertyId,
      limitations: ["The stored collection failed; metrics are unavailable."],
    };
  const parsed = schema.safeParse(cached);
  if (!parsed.success)
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.propertyId,
      limitations: ["Stored metrics or timestamp are invalid."],
    };
  const data = parsed.data;
  const provenance = data.provenance;
  if (
    provenance &&
    (provenance.projectId !== input.projectId ||
      provenance.organizationId !== input.organizationId ||
      provenance.property !== connection.propertyId ||
      provenance.binding.id !== connection.id ||
      provenance.binding.userId !== connection.connectedByUserId ||
      provenance.binding.accountId !== connection.ga4AccountId ||
      provenance.binding.updatedAt !== connection.updatedAt)
  )
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.propertyId,
      limitations: [
        "Stored evidence belongs to a different connection or project scope.",
      ],
    };
  const age = Date.now() - Date.parse(data.fetchedAt);
  if (age < 0 || age > 12 * 60 * 60 * 1000)
    return {
      ...unavailable(),
      status: age < 0 ? "invalid" : "stale",
      property: connection.propertyId,
      fetchedAt: data.fetchedAt,
      limitations: [
        age < 0
          ? "Stored timestamp is in the future."
          : "Stored evidence is older than twelve hours.",
      ],
    };
  if (
    provenance &&
    provenance.periods.current.endDate !==
      new Date(
        Date.parse(data.fetchedAt) - provenance.dateBasis.lagDays * 86400_000,
      )
        .toISOString()
        .slice(0, 10)
  )
    return {
      ...unavailable(),
      status: "invalid",
      property: connection.propertyId,
      limitations: [
        "Stored periods do not match the recorded UTC collection date and data lag.",
      ],
    };
  const limitations = ga4EvidenceLimitations(provenance);
  return {
    status: data.provenance ? "available" : "legacy",
    property: connection.propertyId,
    fetchedAt: data.fetchedAt,
    periods: data.provenance?.periods ?? null,
    ...(data.provenance ? { provenance: data.provenance } : {}),
    limitations,
    current: { sessions: data.sessions, activeUsers: data.activeUsers },
    previous: {
      sessions: data.prevSessions,
      activeUsers: data.prevActiveUsers,
    },
  };
}

async function read(input: {
  projectId: string;
  organizationId: string;
}): Promise<{ gsc: StoredGscEvidence; ga4: StoredGa4Evidence }> {
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");
  const failed = () => ({
    ...unavailable(),
    status: "failed" as const,
    limitations: ["Stored evidence could not be read."],
  });
  return {
    gsc: await readGsc(input).catch(failed),
    ga4: await readGa4(input).catch(failed),
  };
}

export const StoredGoogleSnapshotService = { read };
