# SEO Execution Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert existing GSC + GA4 page opportunity data into a project-scoped, explainable, read-only action review experience.

**Architecture:** Pure shared planner maps SearchOpportunityService candidates into deterministic actions and evidence; a project-scoped TanStack server function uses the existing authenticated service; a React project route displays and exports review packets. No database migrations or write tokens.

**Tech Stack:** TypeScript, React, TanStack Start/Router/Query, Zod, Vitest, existing OpenSEO UI.

**Spec:** `docs/maintainers/specs/0017-seo-execution-cockpit.md`

## Global Constraints

- No automatic publish, CMS/DNS changes or Indexing API calls.
- No invented traffic/ROI lift; preserve missing data and source limits.
- Validate the project through requireProjectContext, never trust client projectId for data access.
- Do not change AGENTS.md, skills, authentication, billing or infrastructure.

## Review Focus

- Unmatched GSC-only rows must never inherit scores or conversion metrics.
- Equal-score rows must have deterministic order for stable review packets.
- Zero/negative/NaN metrics must not produce misleading evidence.
- Truncated GSC/GA4 datasets must be signalled.
- Missing integrations should not appear as zero-opportunity results.

---

### Task 1: Deterministic action planner

**Files:**

- Create: `src/shared/seo-execution/plan.ts`
- Test: `src/shared/seo-execution/plan.test.ts`

**Interfaces:**

- Produces: `buildSeoExecutionPlan(result: SearchOpportunitySource): SeoExecutionPlan`
- Produces: `buildSeoReviewPacket(plan: SeoExecutionPlan, selectedIds: readonly string[]): SeoReviewPacket`

- [ ] Write planner tests for joined rows, measurement gaps, truncated coverage and deterministic selection.
- [ ] Run `pnpm exec vitest run src/shared/seo-execution/plan.test.ts`, expect RED missing module.
- [ ] Implement pure planner with evidence, confidence and action checklist; no side effects.
- [ ] Rerun focused tests, expect PASS.
- [ ] Commit task 1.

### Task 2: Authenticated read-only API and page

**Files:**

- Create: `src/serverFunctions/seoExecution.ts`
- Create: `src/client/features/seo-execution/SeoExecutionPage.tsx`
- Create: `src/routes/_app/p/$projectId/execution.tsx`
- Modify: `src/client/navigation/items.ts`

**Interfaces:**

- Consumes: `buildSeoExecutionPlan`
- Produces: `getSeoExecutionPlan({data:{projectId:string}})`
- UI copies selected items as `buildSeoReviewPacket` JSON; it performs no external writes.

- [ ] Write failing test for server function if project provides cheap harness; otherwise let Task 1 pure tests govern business behavior and verify type/build/route.
- [ ] Implement Zod-validated requireProjectContext server function and use source service.
- [ ] Add responsive page, navigation and loading/empty/error/data-gap states.
- [ ] Verify generated routes and TypeScript check.
- [ ] Commit task 2.

### Task 3: Whole-branch validation and review

- [ ] Run focused and full Vitest, typecheck, lint, production build, and check outputs.
- [ ] Review diff for permission, claim, metric and no-write regressions; fix issues before completion.
- [ ] Create draft PR, do not merge or deploy production.
