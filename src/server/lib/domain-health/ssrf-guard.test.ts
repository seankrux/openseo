import { describe, expect, it, vi } from "vitest";
import { checkDomainHealth } from "./check-domain";
import { isPrivateAddress, isPrivateHost } from "./dns";
import { fetchHttpsRoot } from "./https-check";

function withPublicDns(
  fetchImpl: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    if (url.hostname === "cloudflare-dns.com") {
      const Answer =
        url.searchParams.get("type") === "A"
          ? [{ type: 1, data: "8.8.8.8" }]
          : [];
      return Response.json({ Status: 0, Answer });
    }
    return fetchImpl(input, init);
  };
}

describe("domain health private address guard", () => {
  it("flags private, loopback, link-local, CGNAT/tailnet and reserved IPv4", () => {
    for (const ip of [
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.84.140.90",
      "0.0.0.0",
      "224.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "104.21.68.247",
      "172.67.200.131",
      "8.8.8.8",
      "100.128.0.1",
      "172.32.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("flags private IPv6 and mapped IPv4, not public IPv6", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700:3030::ac43:c883")).toBe(false);
  });

  it("flags local host names", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("tokyo.taile2472e.ts.net")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });

  it("does not follow a redirect to an internal address", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://100.84.140.90:8317/v1/models" },
        }),
    );
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private/);
  });

  it("does not follow a redirect to a non-web scheme", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: "file:///etc/passwd" },
        }),
    );
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/not followed/);
  });

  it("still follows normal public redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://www.example.com/" },
        }),
      )
      .mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }));
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(r.ok).toBe(true);
    expect(r.redirectHops).toBe(1);
  });

  it("never fetches a domain whose DNS points at a private address", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = requestUrl(url);
      if (u.startsWith("https://cloudflare-dns.com/")) {
        const type = new URL(u).searchParams.get("type");
        const answer = type === "A" ? [{ type: 1, data: "127.0.0.1" }] : [];
        return new Response(JSON.stringify({ Status: 0, Answer: answer }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const r = await checkDomainHealth("evil.example", {
      fetch: fetchMock,
    });
    expect(r.class).toBe("dns_fail");
    expect(r.error).toMatch(/private/);
    expect(
      fetchMock.mock.calls.every(([u]) =>
        requestUrl(u).startsWith("https://cloudflare-dns.com/"),
      ),
    ).toBe(true);
  });
  it("blocks a public redirect hostname that resolves to private IPv4", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      if (url.hostname === "cloudflare-dns.com") {
        const privateTarget = url.searchParams.get("name") === "hidden.example";
        const type = url.searchParams.get("type");
        return Response.json({
          Status: 0,
          Answer:
            type === "A"
              ? [{ type: 1, data: privateTarget ? "127.0.0.1" : "8.8.8.8" }]
              : [],
        });
      }
      if (url.hostname === "example.com")
        return new Response(null, {
          status: 302,
          headers: { location: "https://hidden.example/" },
        });
      throw new Error("Private redirect target was fetched");
    });
    const result = await fetchHttpsRoot("example.com", { fetch: fetchMock });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private/);
    expect(
      fetchMock.mock.calls.some(
        ([url]) => new URL(requestUrl(url)).hostname === "hidden.example",
      ),
    ).toBe(false);
  });

  it("treats different co.uk domains as a cross-domain redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://other.co.uk/" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const result = await fetchHttpsRoot("example.co.uk", {
      fetch: withPublicDns(fetchMock),
    });
    expect(result.ok).toBe(true);
    expect(result.redirectedOtherDomain).toBe(true);
  });
});

describe("TLS failure detection in workerd", () => {
  it("classifies an opaque HTTPS failure as SSL when plain HTTP answers", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (requestUrl(url).startsWith("https://"))
        throw new Error("internal error; reference = abc123");
      return new Response(null, {
        status: 301,
        headers: { location: "https://example.com/" },
      });
    });
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(r.sslError).toBe(true);
    expect(r.error).toMatch(/certificate or TLS/);
  });

  it("keeps it a connection error when HTTP is down too", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("internal error; reference = abc123");
    });
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(r.sslError).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("does not probe HTTP after a timeout", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    const fetchMock = vi.fn(async () => {
      throw err;
    });
    const r = await fetchHttpsRoot("example.com", {
      fetch: withPublicDns(fetchMock),
    });
    expect(r.timedOut).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
