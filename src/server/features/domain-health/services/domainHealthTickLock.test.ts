import { describe, expect, it, vi } from "vitest";

// The tick reads orgs first; count how often that happens to see overlaps.
let release: () => void = () => {};
const selectDistinct = vi.fn(() => ({
  from: () => ({
    where: () =>
      new Promise<Array<{ organizationId: string }>>((resolve) => {
        release = () => resolve([]);
      }),
  }),
}));
vi.mock("@/db", () => ({
  db: {
    selectDistinct: () => selectDistinct(),
    delete: () => ({ where: async () => undefined }),
  },
}));
vi.mock("@/db/schema", () => ({
  domainHealthCurrent: {},
  domainHealthChecks: {},
  projects: {},
}));
vi.mock(
  "@/server/features/domain-health/repositories/DomainHealthRepository",
  () => ({ DomainHealthRepository: {} }),
);
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { runDomainHealthTick } from "./domainHealthTick";

describe("domain health tick lock", () => {
  it("skips a tick that starts while another is still running", async () => {
    const first = runDomainHealthTick();
    await new Promise((r) => setTimeout(r, 0));
    await runDomainHealthTick();
    expect(selectDistinct).toHaveBeenCalledTimes(1);
    release();
    await first;
    const third = runDomainHealthTick();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await third;
    expect(selectDistinct).toHaveBeenCalledTimes(2);
  });
});
