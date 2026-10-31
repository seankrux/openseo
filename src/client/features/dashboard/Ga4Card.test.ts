import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ga4Card } from "./Ga4Card";

const report = vi.hoisted(() => ({
  connected: true,
  totals: { sessions: null as number | null },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: report, isError: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) =>
    createElement("a", {}, children),
}));
vi.mock("@/serverFunctions/ga4", () => ({ getGa4DashboardReport: vi.fn() }));
vi.mock("./Ga4ConnectCard", () => ({ Ga4ConnectCard: () => null }));

beforeEach(() => {
  report.totals.sessions = null;
});
describe("Ga4Card empty report", () => {
  it("does not describe unavailable evidence as zero organic traffic", () => {
    const html = renderToStaticMarkup(
      createElement(Ga4Card, { projectId: "site-a", connected: true }),
    );
    expect(html).toContain("Organic traffic data is unavailable");
    expect(html).not.toContain("No organic search traffic recorded");
  });
  it("preserves the zero-traffic state for an observed zero", () => {
    report.totals.sessions = 0;
    const html = renderToStaticMarkup(
      createElement(Ga4Card, { projectId: "site-a", connected: true }),
    );
    expect(html).toContain("No organic search traffic recorded");
    expect(html).not.toContain("data is unavailable");
  });
});
