import { beforeEach, describe, expect, it, vi } from "vitest";
import { BingWebmasterClient } from "./BingWebmasterClient";

const { settings, fetchMock } = vi.hoisted(() => ({
  settings: {
    BING_WEBMASTER_ENABLED: "true",
    BING_WEBMASTER_API_KEY: "mock-bing-key",
  },
  fetchMock: vi.fn<typeof fetch>(),
}));
vi.mock("cloudflare:workers", () => ({ env: settings }));

beforeEach(() => {
  settings.BING_WEBMASTER_ENABLED = "true";
  settings.BING_WEBMASTER_API_KEY = "mock-bing-key";
  vi.stubEnv("BING_WEBMASTER_ENABLED", "");
  vi.stubEnv("BING_WEBMASTER_API_KEY", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(Response.json({ d: [] }));
});

function calledUrl() {
  const input = fetchMock.mock.calls[0][0];
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
}

describe("Bing Webmaster read-only client", () => {
  it.each([
    { enabled: "", key: "mock-bing-key" },
    { enabled: "false", key: "mock-bing-key" },
    { enabled: "true", key: "" },
  ])(
    "fails closed without explicit opt-in and a key: $enabled/$key",
    async ({ enabled, key }) => {
      settings.BING_WEBMASTER_ENABLED = enabled;
      settings.BING_WEBMASTER_API_KEY = key;
      await expect(BingWebmasterClient.getUserSites()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["http", "network", "invalid-json", "invalid-shape"])(
    "returns only a safe error code on provider %s failures",
    async (failure) => {
      if (failure === "network")
        fetchMock.mockRejectedValue(
          new Error("https://ssl.bing.com/?apikey=mock-bing-key"),
        );
      else if (failure === "http")
        fetchMock.mockResolvedValue(
          new Response("mock-bing-key", { status: 401 }),
        );
      else if (failure === "invalid-json")
        fetchMock.mockResolvedValue(new Response("mock-bing-key"));
      else
        fetchMock.mockResolvedValue(
          Response.json({ d: [{ Url: "mock-bing-key" }] }),
        );
      const result = await BingWebmasterClient.getUserSites().catch(
        (error: unknown) => error,
      );
      expect(result).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        message: "UPSTREAM_UNAVAILABLE",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts the existing 1,628-site portfolio within the response byte cap", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        d: Array.from({ length: 1628 }, (_, i) => ({
          Url: `https://site-${i}.example.com/`,
          IsVerified: true,
        })),
      }),
    );
    const sites = await BingWebmasterClient.getUserSites();
    expect(sites).toHaveLength(1628);
    expect(sites.at(-1)).toEqual({
      url: "https://site-1627.example.com/",
      isVerified: true,
    });
  });

  it("discovers verified sites with Workers-supported redirect modes", async () => {
    fetchMock.mockImplementation(async (input, options) => {
      const request = new Request(input, options);
      // workerd rejects unsupported redirect modes before making any request.
      if (request.redirect !== "follow" && request.redirect !== "manual") {
        throw new TypeError("Redirect mode must be follow or manual");
      }
      return Response.json({
        d: [{ Url: "https://example.com/", IsVerified: true }],
      });
    });

    await expect(BingWebmasterClient.getUserSites()).resolves.toEqual([
      { url: "https://example.com/", isVerified: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses only the fixed official GET endpoint with redirects refused and a deadline", async () => {
    await BingWebmasterClient.getUserSites();
    const options = fetchMock.mock.calls[0][1];
    expect(calledUrl().href).toBe(
      "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=mock-bing-key",
    );
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("manual");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects HTTP %s without following redirects or leaking provider details",
    async (status) => {
      const response = new Response("mock-body-secret", {
        status,
        headers: {
          Location:
            "https://redirect.example/?apikey=mock-bing-key&token=mock-location-secret",
        },
      });
      const body = vi.spyOn(response, "body", "get");
      fetchMock.mockResolvedValue(response);

      const result = await BingWebmasterClient.getUserSites().catch(
        (error: unknown) => error,
      );
      expect(result).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        message: "UPSTREAM_UNAVAILABLE",
      });
      expect(result).not.toHaveProperty("cause");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
      expect(body).not.toHaveBeenCalled();
      const exposed = JSON.stringify(
        result,
        Object.getOwnPropertyNames(result),
      );
      for (const secret of [
        "mock-bing-key",
        "mock-location-secret",
        "mock-body-secret",
      ]) {
        expect(exposed).not.toContain(secret);
      }
    },
  );

  it.each(["body", "rows"])(
    "bounds provider %s without trusting content-length",
    async (kind) => {
      fetchMock.mockResolvedValue(
        Response.json(
          kind === "body"
            ? { d: [], padding: "x".repeat(1_048_577) }
            : {
                d: Array.from({ length: 10_001 }, () => ({
                  Url: "https://example.com/",
                  IsVerified: true,
                })),
              },
        ),
      );
      await expect(BingWebmasterClient.getUserSites()).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { offset: "+0200", date: "2026-09-05", minutes: 120 },
    { offset: "-0700", date: "2026-09-04", minutes: -420 },
    { offset: "", date: null, minutes: null },
  ])(
    "normalizes performance without inventing timezone: $offset",
    async ({ offset, date, minutes }) => {
      fetchMock.mockResolvedValue(
        Response.json({
          d: [
            {
              Date: `/Date(${Date.UTC(2026, 8, 4, 23, 30)}${offset})/`,
              Clicks: 10,
              Impressions: 20,
              secret: "discard",
            },
          ],
        }),
      );
      expect(
        await BingWebmasterClient.getRankAndTrafficStats(
          "https://example.com/",
        ),
      ).toEqual([
        {
          date,
          timestamp: "2026-09-04T23:30:00.000Z",
          utcOffsetMinutes: minutes,
          clicks: 10,
          impressions: 20,
        },
      ]);
      expect(calledUrl().pathname).toBe(
        "/webmaster/api.svc/json/GetRankAndTrafficStats",
      );
      expect(calledUrl().searchParams.get("siteUrl")).toBe(
        "https://example.com/",
      );
    },
  );

  it("normalizes crawl counts and preserves absent optional metrics", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        d: [
          {
            Date: "/Date(0+0000)/",
            AllOtherCodes: 1,
            BlockedByRobotsTxt: 2,
            Code2xx: 3,
            Code301: 4,
            Code302: 5,
            Code4xx: 6,
            Code5xx: 7,
            ContainsMalware: 8,
            CrawlErrors: 9,
            CrawledPages: 10,
            InIndex: 11,
            InLinks: 12,
            secret: "discard",
          },
        ],
      }),
    );
    expect(
      await BingWebmasterClient.getCrawlStats("https://example.com/"),
    ).toEqual([
      {
        date: "1970-01-01",
        timestamp: "1970-01-01T00:00:00.000Z",
        utcOffsetMinutes: 0,
        allOtherCodes: 1,
        blockedByRobotsTxt: 2,
        code2xx: 3,
        code301: 4,
        code302: 5,
        code4xx: 6,
        code5xx: 7,
        containsMalware: 8,
        crawlErrors: 9,
        crawledPages: 10,
        inIndex: 11,
        inLinks: 12,
      },
    ]);
    expect(calledUrl().pathname).toBe("/webmaster/api.svc/json/GetCrawlStats");
  });

  it.each([
    "/Date(0+1460)/",
    "/Date(0-2500)/",
    "/Date(nope)/",
    "2026-09-04",
    "/Date(999999999999999999)/",
  ])("rejects malformed provider dates: %s", async (date) => {
    fetchMock.mockResolvedValue(
      Response.json({ d: [{ Date: date, Clicks: 1, Impressions: 2 }] }),
    );
    await expect(
      BingWebmasterClient.getRankAndTrafficStats("https://example.com/"),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("discards discovery verification secrets at the provider seam", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        d: [
          {
            Url: "https://example.com/",
            IsVerified: true,
            AuthenticationCode: "mock-verification-code",
            DnsVerificationCode: "mock-dns-code.example.com",
          },
        ],
      }),
    );
    expect(await BingWebmasterClient.getUserSites()).toEqual([
      { url: "https://example.com/", isVerified: true },
    ]);
  });

  it("maps Bing ThrottleUser (ErrorCode 4) and HTTP 429 to RATE_LIMITED without leaking secrets", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ErrorCode: 4, Message: "ERROR!!! ThrottleUser mock-bing-key" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const err1 = await BingWebmasterClient.getUserSites().catch((e: unknown) => e);
    expect(err1).toMatchObject({
      code: "RATE_LIMITED",
      message: "RATE_LIMITED",
    });
    expect(JSON.stringify(err1, Object.getOwnPropertyNames(err1))).not.toContain("mock-bing-key");

    fetchMock.mockResolvedValueOnce(new Response("rate limit", { status: 429 }));
    const err2 = await BingWebmasterClient.getUserSites().catch((e: unknown) => e);
    expect(err2).toMatchObject({
      code: "RATE_LIMITED",
      message: "RATE_LIMITED",
    });
  });
});
