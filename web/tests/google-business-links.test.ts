import { describe, expect, it } from "vitest";
import { parseGoogleBusinessInput } from "../src/lib/free-tools/google-business-links";

describe("parseGoogleBusinessInput", () => {
  it("parses a bare Place ID", () => {
    const id = "ChIJN1t_tDeuEmsRUsoyG83frY4";
    const result = parseGoogleBusinessInput(id);
    expect(result?.placeId).toBe(id);
    expect(result?.reviewUrl).toContain(encodeURIComponent(id));
    expect(result?.mapsPlaceUrl).toContain("query_place_id");
  });

  it("parses cid from a Maps URL", () => {
    const result = parseGoogleBusinessInput(
      "https://www.google.com/maps?cid=12345678901234567890",
    );
    expect(result?.cidDecimal).toBe("12345678901234567890");
    expect(result?.mapsCidUrl).toContain("cid=12345678901234567890");
    expect(result?.reviewUrl).toBeNull();
    expect(result?.note).toMatch(/Place ID/);
  });

  it("parses placeid query param for review links", () => {
    const id = "ChIJN1t_tDeuEmsRUsoyG83frY4";
    const result = parseGoogleBusinessInput(
      `https://search.google.com/local/writereview?placeid=${id}`,
    );
    expect(result?.placeId).toBe(id);
    expect(result?.reviewUrl).toContain(id);
  });
});
