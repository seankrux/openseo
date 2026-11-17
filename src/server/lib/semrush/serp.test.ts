import { describe, expect, it, vi } from "vitest";
import {
  createSemrushSerpProvider,
  parsePhraseOrganicResponse,
  semrushDatabase,
} from "./serp";

const query = {
  keyword: "foundation repair",
  countryCode: "us",
  locationName: null,
  device: "desktop" as const,
  depth: 20,
};

describe("parsePhraseOrganicResponse", () => {
  it("reads position, domain and URL from each line", () => {
    const body = [
      "Position;Domain;Url",
      "1;moz.com;https://moz.com/beginners-guide-to-seo",
      "2;www.example.com;https://www.example.com/a;b?c=d",
      "",
    ].join("\r\n");

    expect(parsePhraseOrganicResponse(200, body)).toEqual([
      {
        position: 1,
        domain: "moz.com",
        url: "https://moz.com/beginners-guide-to-seo",
      },
      {
        position: 2,
        domain: "www.example.com",
        url: "https://www.example.com/a;b?c=d",
      },
    ]);
  });

  it("parses a response captured from the live API", () => {
    const body =
      "Position;Domain;Url\n1;www.rubensfoundationrepairtx.com;https://www.rubensfoundationrepairtx.com/\n2;www.homedepot.com;https://www.homedepot.com/c/ah/7-ways-to-repair-foundations/9ba683603be9fa5395fab9017e00a38a\n";

    expect(parsePhraseOrganicResponse(200, body)).toEqual([
      {
        position: 1,
        domain: "www.rubensfoundationrepairtx.com",
        url: "https://www.rubensfoundationrepairtx.com/",
      },
      {
        position: 2,
        domain: "www.homedepot.com",
        url: "https://www.homedepot.com/c/ah/7-ways-to-repair-foundations/9ba683603be9fa5395fab9017e00a38a",
      },
    ]);
  });

  it("treats NOTHING FOUND as an empty SERP", () => {
    expect(
      parsePhraseOrganicResponse(200, "ERROR 50 :: NOTHING FOUND\n"),
    ).toEqual([]);
  });

  it.each([
    [403, "ERROR 132 :: API UNITS BALANCE IS ZERO", "RATE_LIMITED"],
    [200, "ERROR 134 :: TOTAL LIMIT EXCEEDED", "RATE_LIMITED"],
    [200, "ERROR 120 :: WRONG KEY - ID PAIR", "FORBIDDEN"],
    [403, "ERROR 133 :: DB ACCESS DENIED", "FORBIDDEN"],
    [200, "ERROR 999 :: SOMETHING NEW", "UPSTREAM_UNAVAILABLE"],
  ])("maps HTTP %i %s to %s", (status, body, code) => {
    expect(() => parsePhraseOrganicResponse(status, body)).toThrow(
      expect.objectContaining({ code, message: `Semrush: ${body}` }),
    );
  });

  it.each([
    [429, ""],
    [502, "<html>Bad gateway</html>"],
  ])("rejects HTTP %i without an error line", (status, body) => {
    expect(() => parsePhraseOrganicResponse(status, body)).toThrow(
      expect.objectContaining({
        code: status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
      }),
    );
  });

  it("rejects columns other than the ones requested", () => {
    expect(() =>
      parsePhraseOrganicResponse(200, "Domain;Url\nmoz.com;https://moz.com/"),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
  });

  it.each(["0;moz.com;https://moz.com/", "x;moz.com;https://moz.com/", "1;;u"])(
    "rejects the malformed row %s instead of reading it as not ranking",
    (row) => {
      expect(() =>
        parsePhraseOrganicResponse(200, `Position;Domain;Url\n${row}`),
      ).toThrow(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
    },
  );
});

describe("semrushDatabase", () => {
  it.each([
    ["us", "desktop", "us"],
    ["gb", "desktop", "uk"],
    ["gb", "mobile", "mobile-uk"],
    ["ph", "desktop", "ph"],
    ["ph", "mobile", null],
    ["xx", "desktop", null],
  ] as const)("%s %s -> %s", (country, device, database) => {
    expect(semrushDatabase(country, device)).toBe(database);
  });
});

describe("Semrush SERP provider", () => {
  it("requests phrase_organic for the country database and depth", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("Position;Domain;Url\n3;example.com;https://example.com/"),
    );
    const provider = createSemrushSerpProvider("test-key", fetchImpl);

    const rows = await provider.organicSerp({
      ...query,
      countryCode: "gb",
      device: "mobile",
    });

    expect(rows).toEqual([
      { position: 3, domain: "example.com", url: "https://example.com/" },
    ]);
    const requested = fetchImpl.mock.calls[0]?.[0];
    expect(typeof requested).toBe("string");
    const url = new URL(typeof requested === "string" ? requested : "");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "phrase_organic",
      key: "test-key",
      phrase: "foundation repair",
      database: "mobile-uk",
      display_limit: "20",
      export_columns: "Po,Dn,Ur",
    });
  });

  it.each([
    [{ locationName: "Austin,Texas,United States" }],
    [{ countryCode: "ph", device: "mobile" as const }],
  ])(
    "rejects a market Semrush has no data for without calling it",
    async (overrides) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const provider = createSemrushSerpProvider("test-key", fetchImpl);

      await expect(
        provider.organicSerp({ ...query, ...overrides }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("keeps the key out of network errors", async () => {
    const provider = createSemrushSerpProvider(
      "secret-key",
      vi.fn(async () => {
        throw new TypeError(
          "fetch failed: https://api.semrush.com/?key=secret-key",
        );
      }),
    );

    const error: unknown = await provider
      .organicSerp(query)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(error instanceof Error ? error.message : "").not.toContain(
      "secret-key",
    );
  });
});
