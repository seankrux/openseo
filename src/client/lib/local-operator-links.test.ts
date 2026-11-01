import { describe, expect, it } from "vitest";
import {
  googleMapsSearchUrl,
  mapsSearchQuery,
} from "./local-operator-links";

describe("local-operator-links", () => {
  it("builds a Maps search URL", () => {
    expect(googleMapsSearchUrl("Acme Plumbing")).toContain(
      encodeURIComponent("Acme Plumbing"),
    );
  });

  it("prefers domain for Maps query", () => {
    expect(mapsSearchQuery("example.com", "Example Inc")).toBe("example.com");
  });
});
