// CityThrive fork: stable, name-addressed GSC/GA4 linking for fleet onboarding.
// Replaces scripts that called hashed TanStack `_serverFn` ids. Exposed as MCP
// tools (list_google_properties, link_gsc_property, link_ga4_property,
// auto_link_google_properties) in src/server/mcp/tools/google-linking-tools.ts.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ga4Connections, gscConnections } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { GscService } from "@/server/features/gsc/services/GscService";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { createGa4AdminClient, createGa4DataClient } from "@/server/lib/ga4Client";
import { listProjects } from "@/server/features/projects/services/projects";
import { bareHost, gscCandidatesFor } from "./domain";

export { bareHost, gscCandidatesFor };

export type LinkKind = "gsc" | "ga4" | "both";

type GscSiteRow = { accountId: string; email: string | null; siteUrl: string; permissionLevel: string };
type Ga4PropRow = {
  accountId: string;
  email: string | null;
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
  streamHosts?: string[];
  measurementIds?: string[];
};

async function listGscSites(userId: string) {
  const { accounts } = await GscService.listSitesForUserWithGrantStatus(userId);
  const sites: GscSiteRow[] = [];
  for (const a of accounts) {
    for (const s of a.sites) {
      sites.push({ accountId: a.accountId, email: a.email, siteUrl: s.siteUrl, permissionLevel: s.permissionLevel });
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

async function listGa4Properties(userId: string, includeStreams: boolean) {
  const { accounts } = await Ga4Service.listPropertiesForUserWithGrantStatus(userId);
  const props: Ga4PropRow[] = [];
  for (const a of accounts) {
    for (const p of a.properties) {
      props.push({ accountId: a.accountId, email: a.email, ...p });
    }
  }
  if (includeStreams) {
    await mapLimit(props, 6, async (p) => {
      try {
        const client = createGa4AdminClient({ userId, ga4AccountId: p.accountId });
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

async function listGoogleProperties(input: { userId: string; kind: LinkKind; includeStreams: boolean }) {
  const [gsc, ga4] = await Promise.all([
    input.kind === "ga4" ? null : listGscSites(input.userId),
    input.kind === "gsc" ? null : listGa4Properties(input.userId, input.includeStreams),
  ]);
  return { gsc, ga4 };
}

async function projectOrgOrThrow(projectId: string, organizationId: string) {
  const projects = await listProjects(organizationId);
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new AppError("NOT_FOUND", "Project not found in this organization.");
  return project;
}

async function linkGsc(input: {
  userId: string;
  organizationId: string;
  projectId: string;
  siteUrl: string;
  accountId?: string;
}) {
  await projectOrgOrThrow(input.projectId, input.organizationId);
  let accountId = input.accountId;
  if (!accountId) {
    const { sites } = await listGscSites(input.userId);
    const hit = sites.find((s) => s.siteUrl === input.siteUrl && s.permissionLevel !== "siteUnverifiedUser");
    if (!hit) throw new AppError("NOT_FOUND", `No connected Google login has verified access to ${input.siteUrl}.`);
    accountId = hit.accountId;
  }
  return GscService.setSite({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
    accountId,
    userId: input.userId,
  });
}

function normalizePropertyId(id: string): string {
  const t = id.trim();
  return /^\d+$/.test(t) ? `properties/${t}` : t;
}

async function linkGa4(input: {
  userId: string;
  organizationId: string;
  projectId: string;
  propertyId: string;
  accountId?: string;
}) {
  await projectOrgOrThrow(input.projectId, input.organizationId);
  const propertyId = normalizePropertyId(input.propertyId);
  let accountId = input.accountId;
  if (!accountId) {
    const { properties } = await listGa4Properties(input.userId, false);
    const hit = properties.find((p) => p.propertyId === propertyId);
    if (!hit) throw new AppError("NOT_FOUND", `No connected Google login can see ${propertyId}.`);
    accountId = hit.accountId;
  }
  return Ga4Service.setProperty({
    projectId: input.projectId,
    organizationId: input.organizationId,
    propertyId,
    accountId,
    userId: input.userId,
  });
}

async function ga4Sessions28d(userId: string, p: Ga4PropRow): Promise<number> {
  try {
    const client = createGa4DataClient({ userId, ga4AccountId: p.accountId, propertyId: p.propertyId });
    const r = await client.runReport({
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }],
    } as Parameters<typeof client.runReport>[0]);
    return Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  } catch {
    return -1;
  }
}

export type AutoLinkRow = {
  projectId: string;
  domain: string;
  kind: "gsc" | "ga4";
  action: "linked" | "would_link" | "already_linked" | "no_match" | "ambiguous" | "error";
  target?: string;
  accountId?: string;
  email?: string | null;
  candidates?: string[];
  error?: string;
};

async function autoLink(input: {
  userId: string;
  organizationId: string;
  kind: LinkKind;
  dryRun: boolean;
  overwrite: boolean;
  projectIds?: string[];
  limit?: number;
  ga4OnTie: "skip" | "most_sessions";
}) {
  let projects = (await listProjects(input.organizationId)).filter((p) => !!p.domain);
  if (input.projectIds?.length) {
    const want = new Set(input.projectIds);
    projects = projects.filter((p) => want.has(p.id));
  }
  const rows: AutoLinkRow[] = [];
  const doGsc = input.kind !== "ga4";
  const doGa4 = input.kind !== "gsc";

  const [gscLinked, ga4Linked] = await Promise.all([
    doGsc
      ? db.select({ projectId: gscConnections.projectId, siteUrl: gscConnections.siteUrl }).from(gscConnections).where(eq(gscConnections.organizationId, input.organizationId))
      : [],
    doGa4
      ? db.select({ projectId: ga4Connections.projectId, propertyId: ga4Connections.propertyId }).from(ga4Connections).where(eq(ga4Connections.organizationId, input.organizationId))
      : [],
  ]);
  const gscBy = new Map(gscLinked.map((r) => [r.projectId, r.siteUrl]));
  const ga4By = new Map(ga4Linked.map((r) => [r.projectId, r.propertyId]));

  let budget = input.limit ?? Number.POSITIVE_INFINITY;

  if (doGsc) {
    const { sites } = await listGscSites(input.userId);
    const bySite = new Map<string, GscSiteRow>();
    for (const s of sites) {
      if (s.permissionLevel === "siteUnverifiedUser") continue;
      if (!bySite.has(s.siteUrl)) bySite.set(s.siteUrl, s);
    }
    const emailBy = new Map(sites.map((s) => [s.accountId, s.email]));
    for (const p of projects) {
      const domain = bareHost(p.domain)!;
      const existing = gscBy.get(p.id);
      if (existing && !input.overwrite) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "already_linked", target: existing });
        continue;
      }
      const hit = gscCandidatesFor(domain).map((c) => bySite.get(c)).find(Boolean);
      if (!hit) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "no_match" });
        continue;
      }
      if (existing === hit.siteUrl) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "already_linked", target: existing });
        continue;
      }
      if (input.dryRun || budget <= 0) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "would_link", target: hit.siteUrl, accountId: hit.accountId, email: hit.email });
        continue;
      }
      try {
        await GscConnectionRepository.upsert({
          projectId: p.id,
          organizationId: input.organizationId,
          siteUrl: hit.siteUrl,
          connectedByUserId: input.userId,
          gscAccountId: hit.accountId,
          connectedAccountEmail: emailBy.get(hit.accountId) ?? null,
        });
        budget--;
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "linked", target: hit.siteUrl, accountId: hit.accountId, email: hit.email });
      } catch (e) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "error", target: hit.siteUrl, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (doGa4) {
    const needs = projects.filter((p) => input.overwrite || !ga4By.has(p.id));
    for (const p of projects) {
      if (!input.overwrite && ga4By.has(p.id)) {
        rows.push({ projectId: p.id, domain: bareHost(p.domain)!, kind: "ga4", action: "already_linked", target: ga4By.get(p.id) });
      }
    }
    if (needs.length) {
      const { properties } = await listGa4Properties(input.userId, true);
      const byHost = new Map<string, Ga4PropRow[]>();
      for (const prop of properties) {
        const hosts = new Set<string>(prop.streamHosts ?? []);
        const dn = bareHost(prop.displayName);
        if (dn && dn.includes(".")) hosts.add(dn);
        for (const h of hosts) {
          const list = byHost.get(h) ?? [];
          if (!list.some((x) => x.propertyId === prop.propertyId)) list.push(prop);
          byHost.set(h, list);
        }
      }
      for (const p of needs) {
        const domain = bareHost(p.domain)!;
        let cands = byHost.get(domain) ?? [];
        if (!cands.length) {
          rows.push({ projectId: p.id, domain, kind: "ga4", action: "no_match" });
          continue;
        }
        if (cands.length > 1) {
          if (input.ga4OnTie === "skip") {
            rows.push({ projectId: p.id, domain, kind: "ga4", action: "ambiguous", candidates: cands.map((c) => c.propertyId) });
            continue;
          }
          const scored = await Promise.all(cands.map(async (c) => ({ c, s: await ga4Sessions28d(input.userId, c) })));
          scored.sort((a, b) => b.s - a.s);
          if (scored[0]!.s <= 0 || scored[0]!.s === scored[1]!.s) {
            rows.push({ projectId: p.id, domain, kind: "ga4", action: "ambiguous", candidates: scored.map((x) => `${x.c.propertyId}(${x.s})`) });
            continue;
          }
          cands = [scored[0]!.c];
        }
        const hit = cands[0]!;
        if (ga4By.get(p.id) === hit.propertyId) {
          rows.push({ projectId: p.id, domain, kind: "ga4", action: "already_linked", target: hit.propertyId });
          continue;
        }
        if (input.dryRun || budget <= 0) {
          rows.push({ projectId: p.id, domain, kind: "ga4", action: "would_link", target: hit.propertyId, accountId: hit.accountId, email: hit.email });
          continue;
        }
        try {
          const client = createGa4AdminClient({ userId: input.userId, ga4AccountId: hit.accountId });
          const property = await client.getProperty(hit.propertyId);
          await Ga4ConnectionRepository.upsert({
            projectId: p.id,
            organizationId: input.organizationId,
            propertyId: property.name,
            propertyDisplayName: property.displayName,
            propertyTimeZone: property.timeZone,
            propertyCurrencyCode: property.currencyCode,
            connectedByUserId: input.userId,
            ga4AccountId: hit.accountId,
            connectedAccountEmail: hit.email,
          });
          budget--;
          rows.push({ projectId: p.id, domain, kind: "ga4", action: "linked", target: property.name, accountId: hit.accountId, email: hit.email });
        } catch (e) {
          rows.push({ projectId: p.id, domain, kind: "ga4", action: "error", target: hit.propertyId, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  }

  const summary: Record<string, number> = {};
  for (const r of rows) summary[`${r.kind}.${r.action}`] = (summary[`${r.kind}.${r.action}`] ?? 0) + 1;
  return { summary, rows };
}

export const GoogleLinkingService = { listGoogleProperties, linkGsc, linkGa4, autoLink };
