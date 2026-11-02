import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FleetReauditControls } from "./FleetReauditPanel";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));
vi.mock("@/serverFunctions/portfolio", () => ({}));

type Props = Parameters<typeof FleetReauditControls>[0];
const rates = {
  gentle: { perTick: 3, maxRunning: 6 },
  normal: { perTick: 5, maxRunning: 10 },
  fast: { perTick: 10, maxRunning: 20 },
};
const defaults = (): Props["status"] => ({
  mode: "off",
  staleDays: 7,
  rates,
  due: 1628,
  running: 0,
  queued: 0,
  lastTick: null,
});
function render(overrides: Partial<Props> = {}) {
  const props: Props = {
    status: defaults(),
    viewCount: 424,
    busy: false,
    onMode: () => {},
    onQueueView: () => {},
    onCancelQueue: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(FleetReauditControls, props));
}

describe("FleetReauditControls", () => {
  it("states how many audits are stale and offers each schedule with its pace", () => {
    const html = render();
    expect(html).toContain("1,628 sites have audits older than 7 days");
    expect(html).toContain("Off");
    expect(html).toContain("Gentle, 3 every 5 min");
    expect(html).toContain("Normal, 5 every 5 min");
    expect(html).toContain("Fast, 10 every 5 min");
    expect(html).toMatch(/<option value="off" selected/);
  });

  it("offers to re-audit the sites in the current view, with how long it takes", () => {
    const html = render({
      status: { ...defaults(), mode: "gentle" },
    });
    expect(html).toContain("Re-audit 424 sites in this view");
    // 424 sites at 3 per 5 minutes is 142 ticks, about 11.8 hours.
    expect(html).toContain("about 12 hours");
  });

  it("shows waiting and running audits with a way to cancel the waiting ones", () => {
    const html = render({
      status: { ...defaults(), queued: 40, running: 5 },
    });
    expect(html).toContain("5 running");
    expect(html).toContain("40 waiting");
    expect(html).toContain("Cancel 40 waiting");
  });

  it("names sites that could not start on the last run", () => {
    const html = render({
      status: {
        ...defaults(),
        lastTick: {
          at: "2026-10-30T12:05:00Z",
          started: 2,
          failed: 1,
          errors: [{ projectId: "p1", code: "VALIDATION_ERROR" }],
        },
      },
    });
    expect(html).toContain("Last run started 2");
    expect(html).toContain("1 could not start (VALIDATION_ERROR)");
  });
});
