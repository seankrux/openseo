import { beforeEach, describe, expect, it, vi } from "vitest";
import { setHostsInTagMap, verifyTagLive } from "./cloudflareTag";

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) =>
    name === "GA4_SETUP_KV_NAMESPACE_ID" ? "namespace" : undefined,
}));

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.hostname === "cloudflare-dns.com") {
      return Response.json({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? [{ type: 1, data: "8.8.8.8" }]
            : [],
      });
    }
    return new Response("<head></head>");
  });
});

describe("GA4 tag verification", () => {
  it("checks www even when the apex serves HTML without the tag", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response(
        url.hostname === "www.example.com"
          ? "<head>G-TEST123</head>"
          : "<head></head>",
      );
    });
    expect(await verifyTagLive("example.com", "G-TEST123")).toMatchObject({
      live: true,
      url: "https://www.example.com/",
    });
  });

  it("does not follow private-address redirects", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === "cloudflare-dns.com")
        return Response.json({ Status: 0, Answer: [] });
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    });
    expect(await verifyTagLive("example.com", "G-TEST123")).toMatchObject({
      live: false,
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        requestUrl(input).startsWith("http://169.254"),
      ),
    ).toBe(false);
    for (const [input, init] of fetchMock.mock.calls) {
      if (!requestUrl(input).startsWith("https://cloudflare-dns.com")) {
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    }
  });

  it("does not accept a measurement ID from an HTTP error page", async () => {
    fetchMock.mockImplementation(async (input) =>
      requestUrl(input).startsWith("https://cloudflare-dns.com")
        ? Response.json({ Status: 0, Answer: [] })
        : new Response("G-TEST123", { status: 500 }),
    );
    expect(await verifyTagLive("example.com", "G-TEST123")).toMatchObject({
      live: false,
    });
  });
});

it("does not overwrite the installed tag map after malformed stored data", async () => {
  fetchMock.mockResolvedValue(new Response("not JSON"));
  await expect(
    setHostsInTagMap(
      { token: "test-token", accountId: "test-account" },
      { "example.com": "G-TEST123" },
    ),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
