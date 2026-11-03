import { aliasedTable } from "drizzle-orm";

import { account } from "@/db/schema";

import { db } from "@/db";

import { projects } from "@/db/schema";

import { gscConnections } from "@/db/schema";

import { ga4Connections } from "@/db/schema";

import { bingSiteBindings } from "@/db/schema";

import { and } from "drizzle-orm";

import { eq } from "drizzle-orm";

import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";

import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

import { sql } from "drizzle-orm";

import { hasBingWorkspaceAccess } from "@/server/features/bing/BingWorkspaceAccess";

import { isNull } from "drizzle-orm";

export async function listFleet(organizationId: string) {
  const gscGrant = aliasedTable(account, "fleet_gsc_grant");
  const ga4Grant = aliasedTable(account, "fleet_ga4_grant");
  return db
    .select({
      projectId: projects.id,
      name: projects.name,
      domain: projects.domain,
      siteUrl: gscConnections.siteUrl,
      gscUserId: gscConnections.connectedByUserId,
      gscAccountId: gscConnections.gscAccountId,
      gscEmail: gscConnections.connectedAccountEmail,
      gscUpdatedAt: gscConnections.updatedAt,
      gscGrantUpdatedAt: gscGrant.updatedAt,
      ga4PropertyId: ga4Connections.propertyId,
      ga4PropertyTimeZone: ga4Connections.propertyTimeZone,
      ga4UserId: ga4Connections.connectedByUserId,
      ga4AccountId: ga4Connections.ga4AccountId,
      ga4Email: ga4Connections.connectedAccountEmail,
      ga4UpdatedAt: ga4Connections.updatedAt,
      ga4GrantUpdatedAt: ga4Grant.updatedAt,
      bingBindingId: bingSiteBindings.id,
      bingSiteUrl: bingSiteBindings.siteUrl,
    })
    .from(projects)
    .leftJoin(
      gscConnections,
      and(
        eq(gscConnections.projectId, projects.id),
        eq(gscConnections.organizationId, projects.organizationId),
      ),
    )
    .leftJoin(
      ga4Connections,
      and(
        eq(ga4Connections.projectId, projects.id),
        eq(ga4Connections.organizationId, projects.organizationId),
      ),
    )
    .leftJoin(
      gscGrant,
      and(
        eq(gscGrant.userId, gscConnections.connectedByUserId),
        eq(gscGrant.providerId, GSC_OAUTH_PROVIDER_ID),
        eq(gscGrant.accountId, gscConnections.gscAccountId),
      ),
    )
    .leftJoin(
      ga4Grant,
      and(
        eq(ga4Grant.userId, ga4Connections.connectedByUserId),
        eq(ga4Grant.providerId, GA4_OAUTH_PROVIDER_ID),
        eq(ga4Grant.accountId, ga4Connections.ga4AccountId),
      ),
    )
    .leftJoin(
      bingSiteBindings,
      and(
        eq(bingSiteBindings.projectId, projects.id),
        eq(bingSiteBindings.organizationId, projects.organizationId),
        // A global key is not an entitlement for arbitrary hosted organizations.
        sql`${hasBingWorkspaceAccess(organizationId) ? 1 : 0} = 1`,
      ),
    )
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(projects.id);
}

export type FleetRow = Awaited<ReturnType<typeof listFleet>>[number];
