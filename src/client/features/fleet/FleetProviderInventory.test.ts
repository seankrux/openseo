import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FleetProviderInventory } from "./FleetProviderInventory";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) =>
    createElement("a", {}, children),
}));

type Inventory = Parameters<typeof FleetProviderInventory>[0]["inventory"];
const unlinked = {
  status: "unlinked",
  property: null,
  accountId: null,
  email: null,
  fetchedAt: null,
  error: null,
  metrics: null,
} as const;
function site(overrides: Partial<Inventory[number]> = {}): Inventory[number] {
  return {
    projectId: "site-a",
    name: "Site A",
    domain: "example.com",
    gsc: unlinked,
    ga4: unlinked,
    bing: unlinked,
    ...overrides,
  };
}

describe("FleetProviderInventory", () => {
  it("retains all active websites in coverage while paginating the table", () => {
    const inventory = Array.from({ length: 1628 }, (_, i) =>
      site({ projectId: `site-${i}`, domain: `site-${i}.example` }),
    );
    const html = renderToStaticMarkup(
      createElement(FleetProviderInventory, { inventory }),
    );
    expect(html).toContain("1,628 active websites");
    expect(html).toContain("site-0.example");
    expect(html).toContain("site-24.example");
    expect(html).not.toContain("site-25.example");
    expect(html).toContain("Next page");
  });

  it("distinguishes unavailable account evidence from real zero activity", () => {
    const html = renderToStaticMarkup(
      createElement(FleetProviderInventory, {
        inventory: [
          site({
            gsc: {
              ...unlinked,
              status: "available",
              property: "sc-domain:example.com",
              accountId: "healthy",
              email: "healthy@example.com",
              fetchedAt: "2026-10-27T12:00:00Z",
              metrics: {
                clicks: 0,
                prevClicks: 0,
                impressions: 0,
                prevImpressions: 0,
                position: null,
                prevPosition: null,
              },
            },
            ga4: {
              ...unlinked,
              status: "error",
              property: "1234",
              accountId: "revoked",
              email: "revoked@example.com",
              error: "Reconnect this account",
            },
          }),
        ],
      }),
    );
    expect(html).toContain("0 clicks · 0 impressions");
    expect(html).toContain("Unavailable · error");
    expect(html).toContain("revoked@example.com");
    expect(html).toContain("Reconnect this account");
    expect(html).not.toContain("0 sessions");
    expect(html).toContain("Not linked");
  });
});
