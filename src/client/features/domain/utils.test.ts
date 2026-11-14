import { describe, expect, it } from "vitest";
import { formatMetric } from "./utils";

describe("domain overview metric display", () => {
  it("keeps a measured zero distinct from unavailable data", () => {
    expect(formatMetric(0)).toBe("0");
    expect(formatMetric(null)).toBe("-");
    expect(formatMetric(undefined)).toBe("-");
  });
});
