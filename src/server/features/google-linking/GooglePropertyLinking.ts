import { listProjects } from "@/server/features/projects/services/projects";

import { AppError } from "@/server/lib/errors";

import { GscService } from "@/server/features/gsc/services/GscService";

import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";

import { listGa4Properties, listGscSites } from "./GooglePropertyDiscovery";

async function projectOrgOrThrow(projectId: string, organizationId: string) {
  const projects = await listProjects(organizationId);
  const project = projects.find((p) => p.id === projectId);
  if (!project)
    throw new AppError("NOT_FOUND", "Project not found in this organization.");
  return project;
}

export async function linkGsc(input: {
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
    const hit = sites.find(
      (s) =>
        s.siteUrl === input.siteUrl &&
        s.permissionLevel !== "siteUnverifiedUser",
    );
    if (!hit)
      throw new AppError(
        "NOT_FOUND",
        `No connected Google login has verified access to ${input.siteUrl}.`,
      );
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

export async function linkGa4(input: {
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
    if (!hit)
      throw new AppError(
        "NOT_FOUND",
        `No connected Google login can see ${propertyId}.`,
      );
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
