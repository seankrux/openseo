import { GscService } from "@/server/features/gsc/services/GscService";
import { mapConcurrent as mapLimit } from "@/server/lib/map-concurrent";

import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";

import { createGa4AdminClient } from "@/server/lib/ga4Client";

import { bareHost } from "./domain";

export type LinkKind = "gsc" | "ga4" | "both";

export type GscSiteRow = {
  accountId: string;
  email: string | null;
  siteUrl: string;
  permissionLevel: string;
};

export type Ga4PropRow = {
  accountId: string;
  email: string | null;
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
  streamHosts?: string[];
  measurementIds?: string[];
};

export async function listGscSites(userId: string) {
  const { accounts } = await GscService.listSitesForUserWithGrantStatus(userId);
  const sites: GscSiteRow[] = [];
  for (const a of accounts) {
    for (const s of a.sites) {
      sites.push({
        accountId: a.accountId,
        email: a.email,
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      });
    }
  }
  return {
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      email: a.email,
      requiresReconnect: a.requiresReconnect,
      siteCount: a.sites.length,
    })),
    sites,
  };
}

export async function listGa4Properties(
  userId: string,
  includeStreams: boolean,
) {
  const { accounts } =
    await Ga4Service.listPropertiesForUserWithGrantStatus(userId);
  const props: Ga4PropRow[] = [];
  for (const a of accounts) {
    for (const p of a.properties) {
      props.push({ accountId: a.accountId, email: a.email, ...p });
    }
  }
  if (includeStreams) {
    await mapLimit(props, 6, async (p) => {
      try {
        const client = createGa4AdminClient({
          userId,
          ga4AccountId: p.accountId,
        });
        const streams = await client.listDataStreams(p.propertyId);
        p.streamHosts = streams
          .map((s) => bareHost(s.webStreamData?.defaultUri))
          .filter((h): h is string => !!h);
        p.measurementIds = streams
          .map((s) => s.webStreamData?.measurementId)
          .filter((m): m is string => !!m);
      } catch {
        p.streamHosts = [];
      }
    });
  }
  return {
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      email: a.email,
      requiresReconnect: a.requiresReconnect,
      propertyCount: a.properties.length,
    })),
    properties: props,
  };
}

export async function listGoogleProperties(input: {
  userId: string;
  kind: LinkKind;
  includeStreams: boolean;
}) {
  const [gsc, ga4] = await Promise.all([
    input.kind === "ga4" ? null : listGscSites(input.userId),
    input.kind === "gsc"
      ? null
      : listGa4Properties(input.userId, input.includeStreams),
  ]);
  return { gsc, ga4 };
}
