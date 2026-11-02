/**
 * Cron entrypoints (mirrors scheduledRankChecks):
 * - daily full pass over every tracked fleet domain
 * - frequent problem recheck (domains with nextCheckAt due and non-live class)
 *
 * Wire from src/server.ts scheduled() — see README.
 */
import { checkDomainHealthBatch } from "@/server/lib/domain-health";
import { DomainHealthRepository } from "@/server/features/domain-health/repositories/DomainHealthRepository";

const FULL_PASS_CONCURRENCY = 20;
const PROBLEM_CONCURRENCY = 10;

export type DomainHealthCronMode = "full" | "problems";

export async function runScheduledDomainHealth(input: {
  organizationId: string;
  mode: DomainHealthCronMode;
  /** Optional override list (e.g. seeded from projects.domain). */
  domains?: string[];
}) {
  const nowIso = new Date().toISOString();

  let domains: string[];
  if (input.mode === "full") {
    if (input.domains?.length) {
      domains = input.domains;
    } else {
      const rows = await DomainHealthRepository.listAllDomainsForOrg(
        input.organizationId,
      );
      domains = rows.map((r) => r.domain);
    }
  } else {
    const due = await DomainHealthRepository.listDueProblemDomains(nowIso);
    domains = due
      .filter((r) => r.organizationId === input.organizationId)
      .map((r) => r.domain);
  }

  if (domains.length === 0) {
    console.log(`[domain-health] ${input.mode}: nothing due`);
    return { checked: 0, changes: 0 };
  }

  const concurrency =
    input.mode === "full" ? FULL_PASS_CONCURRENCY : PROBLEM_CONCURRENCY;
  const trigger =
    input.mode === "full" ? "scheduled_full" : "scheduled_problem";

  const results = await checkDomainHealthBatch(domains, { concurrency });
  let changeCount = 0;
  for (const result of results) {
    const changes = await DomainHealthRepository.recordCheck({
      organizationId: input.organizationId,
      result,
      trigger,
    });
    changeCount += changes.length;
  }

  console.log(
    `[domain-health] ${input.mode}: checked=${results.length} changes=${changeCount}`,
  );
  return { checked: results.length, changes: changeCount };
}
