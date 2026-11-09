import { withPgClient } from "@/db";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import { BingBindingRepository } from "./BingBindingRepository";
import { BingWebmasterClient } from "./BingWebmasterClient";
import { BingSnapshotStore } from "./BingSnapshotStore";
import type { BingSnapshot } from "./BingSnapshot";
import {
  hasBingWorkspaceAccess,
  requireBingManagerAccess,
  requireBingWorkspaceAccess,
} from "./BingWorkspaceAccess";
export type { BingSnapshot } from "./BingSnapshot";

type Scope = { projectId: string; organizationId: string };
type ManagerScope = Scope & { userId: string };
type BindInput = ManagerScope & { siteUrl: string };

function matchesProjectHost(siteUrl: string, domain: string | null): boolean {
  if (!domain || siteUrl.length > 2048) return false;
  try {
    const site = new URL(siteUrl);
    const project = new URL(
      domain.includes("://") ? domain : `https://${domain}`,
    );
    return (
      ["https:", "http:"].includes(site.protocol) &&
      (siteUrl === site.origin || siteUrl === `${site.origin}/`) &&
      !site.username &&
      !site.password &&
      !site.port &&
      !site.search &&
      !site.hash &&
      site.pathname === "/" &&
      site.hostname === project.hostname &&
      !project.username &&
      !project.password &&
      !project.port &&
      !project.search &&
      !project.hash &&
      project.pathname === "/"
    );
  } catch {
    return false;
  }
}

async function listSites(input: ManagerScope) {
  requireBingManagerAccess(input);
  return withPgClient(async () => {
    const project = await ProjectRepository.getProjectForOrganization(
      input.projectId,
      input.organizationId,
    );
    if (!project) throw new AppError("NOT_FOUND");
    const sites = await BingWebmasterClient.getUserSites();
    requireBingManagerAccess(input);
    const current = await ProjectRepository.getProjectForOrganization(
      project.id,
      project.organizationId,
    );
    if (!current || current.domain !== project.domain)
      throw new AppError("CONFLICT");
    const binding = await BingBindingRepository.get(input);
    const counts = new Map<string, number>();
    for (const site of sites)
      counts.set(site.url, (counts.get(site.url) ?? 0) + 1);
    return {
      sites: sites
        .filter(
          (site) =>
            site.isVerified &&
            counts.get(site.url) === 1 &&
            matchesProjectHost(site.url, current.domain),
        )
        .map((site) => ({
          siteUrl: site.url,
          isSelected: binding?.siteUrl === site.url,
        })),
    };
  });
}

async function bindSite(input: BindInput) {
  requireBingManagerAccess(input);
  return withPgClient(async () => {
    const project = await ProjectRepository.getProjectForOrganization(
      input.projectId,
      input.organizationId,
    );
    if (!project) throw new AppError("NOT_FOUND");
    if (!matchesProjectHost(input.siteUrl, project.domain))
      throw new AppError("VALIDATION_ERROR");
    const sites = await BingWebmasterClient.getUserSites();
    const match = sites.filter((site) => site.url === input.siteUrl);
    if (match.length !== 1 || !match[0]?.isVerified)
      throw new AppError("VALIDATION_ERROR");
    const current = await ProjectRepository.getProjectForOrganization(
      project.id,
      project.organizationId,
    );
    if (!current || current.domain !== project.domain)
      throw new AppError("CONFLICT");
    requireBingManagerAccess(input);
    const now = new Date().toISOString();
    const binding = {
      id: crypto.randomUUID(),
      projectId: project.id,
      organizationId: project.organizationId,
      siteUrl: input.siteUrl,
      connectedByUserId: input.userId,
      createdAt: now,
      updatedAt: now,
    };
    // matchesProjectHost established a nonempty domain above.
    if (!project.domain) throw new AppError("VALIDATION_ERROR");
    await BingBindingRepository.save(binding, project.domain);
    const saved = await BingBindingRepository.get(input);
    if (!saved || saved.id !== binding.id) throw new AppError("CONFLICT");
    return saved;
  });
}

async function disconnect(input: ManagerScope): Promise<void> {
  requireBingManagerAccess(input);
  return withPgClient(async () => {
    const project = await ProjectRepository.getProjectForOrganization(
      input.projectId,
      input.organizationId,
    );
    if (!project) throw new AppError("NOT_FOUND");
    const binding = await BingBindingRepository.get(input);
    if (!binding) return;
    const current = await ProjectRepository.getProjectForOrganization(
      project.id,
      project.organizationId,
    );
    requireBingManagerAccess(input);
    if (!current) throw new AppError("CONFLICT");
    await BingBindingRepository.remove({ ...input, bindingId: binding.id });
    if (await BingBindingRepository.get(input)) throw new AppError("CONFLICT");
  });
}

async function getContext(scope: Scope) {
  if (!hasBingWorkspaceAccess(scope.organizationId)) return null;
  const project = await ProjectRepository.getProjectForOrganization(
    scope.projectId,
    scope.organizationId,
  );
  if (!project) return null;
  const binding = await BingBindingRepository.get({
    projectId: project.id,
    organizationId: project.organizationId,
  });
  if (!binding || !matchesProjectHost(binding.siteUrl, project.domain))
    return null;
  return { project, binding };
}

async function getConnection(scope: Scope) {
  requireBingWorkspaceAccess(scope.organizationId);
  return withPgClient(async () => {
    const context = await getContext(scope);
    requireBingWorkspaceAccess(scope.organizationId);
    return {
      connected: Boolean(context),
      connectorAvailable: BingWebmasterClient.isAvailable(),
      siteUrl: context?.binding.siteUrl ?? null,
      connectedAt: context?.binding.createdAt ?? null,
    };
  });
}

const CRAWL_REUSE_MS = 7 * 24 * 60 * 60 * 1000;

async function refreshSnapshot(scope: Scope): Promise<BingSnapshot> {
  requireBingWorkspaceAccess(scope.organizationId);
  return withPgClient(async () => {
    const context = await getContext(scope);
    if (!context) throw new AppError("NOT_FOUND");
    const { binding } = context;
    const storedScope = {
      projectId: binding.projectId,
      organizationId: binding.organizationId,
      bindingId: binding.id,
      siteUrl: binding.siteUrl,
    };
    const stored = await BingSnapshotStore.read(storedScope);
    const performance = await BingWebmasterClient.getRankAndTrafficStats(
      binding.siteUrl,
    );
    // Crawl stats move slowly and Bing meters every call against one daily
    // quota per key. Reuse recent crawl rows so a fleet sweep costs one call
    // per site instead of two.
    const storedCrawlAt = stored
      ? (stored.crawlFetchedAt ?? stored.fetchedAt)
      : null;
    const reuseCrawl =
      stored !== null &&
      storedCrawlAt !== null &&
      Date.now() - Date.parse(storedCrawlAt) < CRAWL_REUSE_MS;
    const crawl = reuseCrawl
      ? stored.crawl
      : await BingWebmasterClient.getCrawlStats(binding.siteUrl);
    const crawlFetchedAt = reuseCrawl
      ? storedCrawlAt!
      : new Date().toISOString();
    const snapshot: BingSnapshot = {
      schemaVersion: 1,
      provider: "bing-webmaster",
      projectId: binding.projectId,
      organizationId: binding.organizationId,
      bindingId: binding.id,
      siteUrl: binding.siteUrl,
      fetchedAt: new Date().toISOString(),
      crawlFetchedAt,
      performance,
      crawl,
      scope: {
        aggregation: "daily",
        performanceSurfaces: "combined Bing surfaces",
        timezone: null,
        window: "provider-returned dates",
        comparableToGoogleSearchConsole: false,
      },
      limitations: [
        "Performance combines Web, Chat, News, Images, Videos and Knowledge Panel; it is not web-only.",
        "Dates and coverage are provider-returned; missing rows are not zero activity. Crawl history is limited to six months.",
        "Provider offsets are preserved when supplied; the reporting timezone is unconfirmed.",
        "Bing and Google Search Console scopes differ and must not be treated as directly comparable.",
      ],
    };
    const current = await getContext(scope);
    if (
      !current ||
      current.binding.id !== binding.id ||
      current.binding.siteUrl !== binding.siteUrl ||
      current.project.domain !== context.project.domain
    )
      throw new AppError("CONFLICT");
    await BingSnapshotStore.save(snapshot);
    return snapshot;
  });
}

async function getStoredSnapshot(scope: Scope): Promise<BingSnapshot | null> {
  // Optional report evidence must be absent, not fatal, in unsupported modes.
  // Gate before acquiring a DB connection, including for legacy bindings.
  if (!hasBingWorkspaceAccess(scope.organizationId)) return null;
  return withPgClient(async () => {
    const context = await getContext(scope);
    if (!context) return null;
    const snapshot = await BingSnapshotStore.read({
      projectId: context.binding.projectId,
      organizationId: context.binding.organizationId,
      bindingId: context.binding.id,
      siteUrl: context.binding.siteUrl,
    });
    if (!snapshot) return null;
    const current = await getContext(scope);
    if (
      !current ||
      current.binding.id !== context.binding.id ||
      current.binding.siteUrl !== context.binding.siteUrl ||
      current.project.domain !== context.project.domain
    )
      return null;
    return snapshot;
  });
}

export const BingWebmasterService = {
  getConnection,
  listSites,
  bindSite,
  disconnect,
  refreshSnapshot,
  getStoredSnapshot,
} as const;
