import { describe, expect, it } from "vitest";
import { detectStatusChanges } from "./detectStatusChanges";

describe("detectStatusChanges", () => {
  it("emits went_down and class_changed", () => {
    const changes = detectStatusChanges(
      { class: "live_ok", sslDaysRemaining: 90, ga4Ids: ["G-A"], gtmIds: [] },
      { class: "timeout", sslDaysRemaining: 90, ga4Ids: ["G-A"], gtmIds: [] },
    );
    expect(changes.map((c) => c.kind).sort()).toEqual(
      ["class_changed", "went_down"].sort(),
    );
  });

  it("emits came_back", () => {
    const changes = detectStatusChanges(
      { class: "dns_fail", sslDaysRemaining: null, ga4Ids: [], gtmIds: [] },
      { class: "live_ok", sslDaysRemaining: 60, ga4Ids: [], gtmIds: [] },
    );
    expect(changes.some((c) => c.kind === "came_back")).toBe(true);
  });

  it("emits ssl_expiring_soon once under 14 days", () => {
    const changes = detectStatusChanges(
      { class: "live_ok", sslDaysRemaining: 30, ga4Ids: [], gtmIds: [] },
      { class: "live_ok", sslDaysRemaining: 10, ga4Ids: [], gtmIds: [] },
    );
    expect(changes).toEqual([
      expect.objectContaining({ kind: "ssl_expiring_soon" }),
    ]);
  });

  it("emits ga4_tag_removed", () => {
    const changes = detectStatusChanges(
      {
        class: "live_ok",
        sslDaysRemaining: 90,
        ga4Ids: ["G-OLD", "G-KEEP"],
        gtmIds: ["GTM-1"],
      },
      {
        class: "live_ok",
        sslDaysRemaining: 90,
        ga4Ids: ["G-KEEP"],
        gtmIds: ["GTM-1"],
      },
    );
    expect(changes[0]).toMatchObject({
      kind: "ga4_tag_removed",
      detail: { removed: ["G-OLD"] },
    });
  });

  it("emits nothing on first snapshot", () => {
    expect(
      detectStatusChanges(null, {
        class: "live_ok",
        sslDaysRemaining: 90,
        ga4Ids: [],
        gtmIds: [],
      }),
    ).toEqual([]);
  });
});
