import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { audits, auditIssues } from "@/db/schema";

// Deliberately saved reads only. AuditService.getStatus can reconcile/mutate.
async function getLatestCompletedAudit(projectId: string) {
  const [audit] = await db
    .select({
      auditId: audits.id,
      startUrl: audits.startUrl,
      startedAt: audits.startedAt,
      completedAt: audits.completedAt,
      pagesCrawled: audits.pagesCrawled,
    })
    .from(audits)
    .where(
      and(
        eq(audits.projectId, projectId),
        eq(audits.status, "completed"),
        isNotNull(audits.completedAt),
      ),
    )
    .orderBy(desc(audits.completedAt), desc(audits.id))
    .limit(1);
  if (!audit) return null;

  // The child identifier comes only from the project-scoped parent above.
  const counts = await db
    .select({ severity: auditIssues.severity, total: count() })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, audit.auditId))
    .groupBy(auditIssues.severity);
  const total = (severity: "critical" | "warning" | "info") =>
    counts.find((row) => row.severity === severity)?.total ?? 0;
  return {
    ...audit,
    criticalIssues: total("critical"),
    warningIssues: total("warning"),
    informationalIssues: total("info"),
  };
}

export const ProjectHealthRepository = { getLatestCompletedAudit };
