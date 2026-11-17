import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { bingSiteBindings, projects } from "@/db/schema";

type Scope = { projectId: string; organizationId: string };
type Binding = typeof bingSiteBindings.$inferSelect;

async function get(scope: Scope): Promise<Binding | null> {
  const [row] = await db
    .select()
    .from(bingSiteBindings)
    .where(
      and(
        eq(bingSiteBindings.projectId, scope.projectId),
        eq(bingSiteBindings.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function save(binding: Binding, expectedDomain: string): Promise<void> {
  // INSERT ... SELECT closes the discovery-to-write organization/host/archive race
  // on both dialects. An absent canonical project writes nothing, even on upsert.
  await runBatch((tx) => [
    tx
      .insert(bingSiteBindings)
      .select(
        tx
          .select({
            id: sql<string>`${binding.id}`.as("id"),
            projectId: projects.id,
            organizationId: projects.organizationId,
            siteUrl: sql<string>`${binding.siteUrl}`.as("site_url"),
            connectedByUserId: sql<string>`${binding.connectedByUserId}`.as(
              "connected_by_user_id",
            ),
            createdAt: sql<string>`${binding.createdAt}`.as("created_at"),
            updatedAt: sql<string>`${binding.updatedAt}`.as("updated_at"),
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, binding.projectId),
              eq(projects.organizationId, binding.organizationId),
              eq(projects.domain, expectedDomain),
              isNull(projects.archivedAt),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: bingSiteBindings.projectId,
        set: binding,
        setWhere: eq(bingSiteBindings.organizationId, binding.organizationId),
      }),
  ]);
}

async function remove(scope: Scope & { bindingId: string }): Promise<void> {
  await runBatch((tx) => [
    tx.delete(bingSiteBindings).where(
      and(
        eq(bingSiteBindings.id, scope.bindingId),
        eq(bingSiteBindings.projectId, scope.projectId),
        eq(bingSiteBindings.organizationId, scope.organizationId),
        exists(
          tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, scope.projectId),
                eq(projects.organizationId, scope.organizationId),
                isNull(projects.archivedAt),
              ),
            ),
        ),
      ),
    ),
  ]);
}

export const BingBindingRepository = { get, save, remove } as const;
