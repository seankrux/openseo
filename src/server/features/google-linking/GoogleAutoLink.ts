import { createGa4DataClient } from "@/server/lib/ga4Client";

import { listProjects } from "@/server/features/projects/services/projects";

import { db } from "@/db";

import { gscConnections } from "@/db/schema";

import { eq } from "drizzle-orm";

import { ga4Connections } from "@/db/schema";

import { bareHost } from "./domain";

import { gscCandidatesFor } from "./domain";

import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";

import { createGa4AdminClient } from "@/server/lib/ga4Client";

import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";

import {
  type Ga4PropRow,
  type GscSiteRow,
  type LinkKind,
  listGa4Properties,
  listGscSites,
} from "./GooglePropertyDiscovery";

async function ga4Sessions28d(userId: string, p: Ga4PropRow): Promise<number> {
  try {
    const client = createGa4DataClient({
      userId,
      ga4AccountId: p.accountId,
      propertyId: p.propertyId,
    });
    const r = await client.runReport({
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }],
      dimensions: [],
      offset: "0",
      limit: "1",
      orderBys: [],
      keepEmptyRows: false,
      returnPropertyQuota: true,
    });
    return Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0);
  } catch {
    return -1;
  }
}

type AutoLinkRow = {
  projectId: string;
  domain: string;
  kind: "gsc" | "ga4";
  action:
    | "linked"
    | "would_link"
    | "already_linked"
    | "no_match"
    | "ambiguous"
    | "error";
  target?: string;
  accountId?: string;
  email?: string | null;
  candidates?: string[];
  error?: string;
};

type AutoLinkInput = {
  userId: string;
  organizationId: string;
  kind: LinkKind;
  dryRun: boolean;
  overwrite: boolean;
  projectIds?: string[];
  limit?: number;
  ga4OnTie: "skip" | "most_sessions";
};

export async function autoLink(input: AutoLinkInput) {
  let projects = (await listProjects(input.organizationId)).filter(
    (p) => !!p.domain,
  );
  if (input.projectIds?.length) {
    const want = new Set(input.projectIds);
    projects = projects.filter((p) => want.has(p.id));
  }
  const rows: AutoLinkRow[] = [];
  const doGsc = input.kind !== "ga4";
  const doGa4 = input.kind !== "gsc";

  const [gscLinked, ga4Linked] = await Promise.all([
    doGsc
      ? db
          .select({
            projectId: gscConnections.projectId,
            siteUrl: gscConnections.siteUrl,
          })
          .from(gscConnections)
          .where(eq(gscConnections.organizationId, input.organizationId))
      : [],
    doGa4
      ? db
          .select({
            projectId: ga4Connections.projectId,
            propertyId: ga4Connections.propertyId,
          })
          .from(ga4Connections)
          .where(eq(ga4Connections.organizationId, input.organizationId))
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
        rows.push({
          projectId: p.id,
          domain,
          kind: "gsc",
          action: "already_linked",
          target: existing,
        });
        continue;
      }
      const hit = gscCandidatesFor(domain)
        .map((c) => bySite.get(c))
        .find(Boolean);
      if (!hit) {
        rows.push({ projectId: p.id, domain, kind: "gsc", action: "no_match" });
        continue;
      }
      if (existing === hit.siteUrl) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "gsc",
          action: "already_linked",
          target: existing,
        });
        continue;
      }
      if (input.dryRun || budget <= 0) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "gsc",
          action: "would_link",
          target: hit.siteUrl,
          accountId: hit.accountId,
          email: hit.email,
        });
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
        rows.push({
          projectId: p.id,
          domain,
          kind: "gsc",
          action: "linked",
          target: hit.siteUrl,
          accountId: hit.accountId,
          email: hit.email,
        });
      } catch (e) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "gsc",
          action: "error",
          target: hit.siteUrl,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (doGa4) rows.push(...(await autoLinkGa4(input, projects, ga4By, budget)));

  const summary: Record<string, number> = {};
  for (const r of rows)
    summary[`${r.kind}.${r.action}`] =
      (summary[`${r.kind}.${r.action}`] ?? 0) + 1;
  return { summary, rows };
}

async function autoLinkGa4(
  input: AutoLinkInput,
  projects: Awaited<ReturnType<typeof listProjects>>,
  ga4By: Map<string, string>,
  budget: number,
) {
  const rows: AutoLinkRow[] = [];

  const needs = projects.filter((p) => input.overwrite || !ga4By.has(p.id));
  for (const p of projects) {
    if (!input.overwrite && ga4By.has(p.id)) {
      rows.push({
        projectId: p.id,
        domain: bareHost(p.domain)!,
        kind: "ga4",
        action: "already_linked",
        target: ga4By.get(p.id),
      });
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
        if (!list.some((x) => x.propertyId === prop.propertyId))
          list.push(prop);
        byHost.set(h, list);
      }
    }
    for (const p of needs) {
      const domain = bareHost(p.domain)!;
      let cands = byHost.get(domain) ?? [];
      if (!cands.length) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "ga4",
          action: "no_match",
        });
        continue;
      }
      if (cands.length > 1) {
        if (input.ga4OnTie === "skip") {
          rows.push({
            projectId: p.id,
            domain,
            kind: "ga4",
            action: "ambiguous",
            candidates: cands.map((c) => c.propertyId),
          });
          continue;
        }
        const scored = await Promise.all(
          cands.map(async (c) => ({
            c,
            s: await ga4Sessions28d(input.userId, c),
          })),
        );
        scored.sort((a, b) => b.s - a.s);
        if (scored[0].s <= 0 || scored[0].s === scored[1].s) {
          rows.push({
            projectId: p.id,
            domain,
            kind: "ga4",
            action: "ambiguous",
            candidates: scored.map((x) => `${x.c.propertyId}(${x.s})`),
          });
          continue;
        }
        cands = [scored[0].c];
      }
      const hit = cands[0];
      if (ga4By.get(p.id) === hit.propertyId) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "ga4",
          action: "already_linked",
          target: hit.propertyId,
        });
        continue;
      }
      if (input.dryRun || budget <= 0) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "ga4",
          action: "would_link",
          target: hit.propertyId,
          accountId: hit.accountId,
          email: hit.email,
        });
        continue;
      }
      try {
        const client = createGa4AdminClient({
          userId: input.userId,
          ga4AccountId: hit.accountId,
        });
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
        rows.push({
          projectId: p.id,
          domain,
          kind: "ga4",
          action: "linked",
          target: property.name,
          accountId: hit.accountId,
          email: hit.email,
        });
      } catch (e) {
        rows.push({
          projectId: p.id,
          domain,
          kind: "ga4",
          action: "error",
          target: hit.propertyId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return rows;
}
