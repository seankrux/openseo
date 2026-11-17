import { describe, expect, it, vi } from "vitest";
import {
  bindingInput,
  client,
  fetchMock,
  getObject,
  getProject,
  objects,
  project,
  providerUrl,
  putObject,
  scope,
  settings,
  useMetrics,
} from "./bing-test-support";
import { BingWebmasterService } from "./BingWebmasterService";

describe("BingWebmasterService snapshots", () => {
  it("does not save after the project is archived during refresh", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    fetchMock.mockImplementation(async () => Response.json({ d: [] }));
    getProject.mockResolvedValueOnce(project).mockResolvedValue(null);
    await expect(
      BingWebmasterService.refreshSnapshot(scope),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("does not save after the binding changes during refresh", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    fetchMock.mockImplementation(async (input) => {
      if (providerUrl(input).includes("GetCrawlStats"))
        await client.execute(
          "UPDATE bing_site_bindings SET id = '11111111-1111-4111-8111-111111111111'",
        );
      return Response.json({ d: [] });
    });
    await expect(
      BingWebmasterService.refreshSnapshot(scope),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(putObject).not.toHaveBeenCalled();
  });

  it("refreshes a private scope-bound normalized snapshot and reads it without HTTP even disabled", async () => {
    const binding = await BingWebmasterService.bindSite(bindingInput);
    fetchMock.mockImplementation(async () => Response.json({ d: [] }));
    const snapshot = await BingWebmasterService.refreshSnapshot(scope);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      provider: "bing-webmaster",
      ...scope,
      bindingId: binding.id,
      siteUrl: bindingInput.siteUrl,
      performance: [],
      crawl: [],
      scope: {
        aggregation: "daily",
        timezone: null,
        comparableToGoogleSearchConsole: false,
      },
    });
    expect(putObject).toHaveBeenCalledTimes(1);
    const key = putObject.mock.calls[0][0];
    expect(key).toContain(
      `bing-webmaster/v1/${scope.organizationId}/project-a/`,
    );
    expect(key).toContain(binding.id);
    vi.stubEnv("BING_WEBMASTER_ENABLED", "false");
    const providerCalls = fetchMock.mock.calls.length;
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toEqual(
      snapshot,
    );
    expect(fetchMock).toHaveBeenCalledTimes(providerCalls);
  });

  it("persists only normalized metrics and private scope metadata", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    const snapshot = await BingWebmasterService.refreshSnapshot(scope);
    expect(snapshot.performance).toEqual([
      {
        date: "2026-09-05",
        timestamp: "2026-09-04T23:30:00.000Z",
        utcOffsetMinutes: 120,
        clicks: 7,
        impressions: 91,
      },
    ]);
    expect(snapshot.crawl[0]).toMatchObject({
      date: null,
      utcOffsetMinutes: null,
      crawledPages: 10,
      inIndex: 11,
      dnsFailures: 4,
    });
    expect(snapshot.crawl[0]).not.toHaveProperty("connectionTimeout");
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toEqual(
      snapshot,
    );
    expect(JSON.stringify(Array.from(objects.values()))).not.toContain(
      "do-not-store",
    );
    expect(JSON.stringify(snapshot)).not.toContain("mock-bing-key");
    expect(putObject.mock.calls[0][2]).toEqual({
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, no-store",
      },
    });
  });

  it.each([
    "http",
    "throttled",
    "malformed",
    "crawl",
    "disabled",
    "missing-key",
    "storage",
  ])("preserves the last valid snapshot after %s failure", async (failure) => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    const prior = await BingWebmasterService.refreshSnapshot(scope);
    const oldObjects = new Map(objects);
    // Crawl rows younger than a week are reused, so a crawl failure can only
    // happen once they have aged out.
    if (failure === "crawl")
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    if (failure === "http")
      fetchMock.mockResolvedValue(
        new Response("mock-bing-key", { status: 500 }),
      );
    if (failure === "throttled")
      fetchMock.mockResolvedValue(
        new Response("mock-bing-key", { status: 429 }),
      );
    if (failure === "malformed")
      fetchMock.mockImplementation(async () =>
        Response.json({
          d: [{ Date: "invalid", Clicks: 1, Impressions: 2 }],
        }),
      );
    if (failure === "crawl")
      fetchMock.mockImplementation(async (input) =>
        providerUrl(input).includes("GetCrawlStats")
          ? new Response("mock-bing-key", { status: 500 })
          : Response.json({ d: [] }),
      );
    if (failure === "disabled") {
      settings.BING_WEBMASTER_ENABLED = "false";
      vi.stubEnv("BING_WEBMASTER_ENABLED", "false");
    }
    if (failure === "missing-key") {
      settings.BING_WEBMASTER_API_KEY = "";
      vi.stubEnv("BING_WEBMASTER_API_KEY", " ");
    }
    if (failure === "storage")
      putObject.mockRejectedValue(new Error("mock-bing-key"));
    const error = await BingWebmasterService.refreshSnapshot(scope).catch(
      (value: unknown) => value,
    );
    expect(error).toMatchObject({
      code:
        failure === "storage"
          ? "INTERNAL_ERROR"
          : failure === "throttled"
            ? "RATE_LIMITED"
            : failure === "disabled" || failure === "missing-key"
              ? "FORBIDDEN"
              : "UPSTREAM_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(objects).toEqual(oldObjects);
    const providerCalls = fetchMock.mock.calls.length;
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toEqual(prior);
    expect(fetchMock).toHaveBeenCalledTimes(providerCalls);
  });

  it.each([
    "invalid-json",
    "foreign-organization",
    "foreign-project",
    "old-binding",
    "foreign-site",
    "wrong-version",
    "negative-count",
    "oversized",
    "future-fetch",
  ])("does not expose invalid stored data: %s", async (kind) => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    const snapshot = await BingWebmasterService.refreshSnapshot(scope);
    const key = putObject.mock.calls[0][0];
    const invalid = {
      ...snapshot,
      fetchedAt:
        kind === "future-fetch"
          ? new Date(Date.now() + 60_000).toISOString()
          : snapshot.fetchedAt,
      organizationId:
        kind === "foreign-organization" ? "org-b" : snapshot.organizationId,
      projectId: kind === "foreign-project" ? "project-b" : snapshot.projectId,
      bindingId:
        kind === "old-binding" ? crypto.randomUUID() : snapshot.bindingId,
      siteUrl:
        kind === "foreign-site" ? "https://foreign.com/" : snapshot.siteUrl,
      schemaVersion: kind === "wrong-version" ? 2 : 1,
      performance:
        kind === "negative-count"
          ? [{ ...snapshot.performance[0], clicks: -1 }]
          : snapshot.performance,
    };
    objects.set(
      key,
      kind === "invalid-json"
        ? "not json"
        : kind === "oversized"
          ? " ".repeat(2_097_153)
          : JSON.stringify(invalid),
    );
    const providerCalls = fetchMock.mock.calls.length;
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(providerCalls);
  });

  it("returns null without HTTP or cross-organization storage lookup for missing, foreign, or archived contexts", async () => {
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    await BingWebmasterService.refreshSnapshot(scope);
    // A refresh reads the prior snapshot to reuse crawl rows; the lookups
    // under test are the ones after it.
    getObject.mockClear();
    const providerCalls = fetchMock.mock.calls.length;
    expect(
      await BingWebmasterService.getStoredSnapshot({
        ...scope,
        organizationId: "org-b",
      }),
    ).toBeNull();
    getProject.mockResolvedValue(null);
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(providerCalls);
  });

  it("reads a fleet row's snapshot without project or binding lookups", async () => {
    const binding = await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    const snapshot = await BingWebmasterService.refreshSnapshot(scope);
    getProject.mockClear();
    const row = {
      ...scope,
      domain: project.domain,
      bindingId: binding.id,
      siteUrl: bindingInput.siteUrl,
    };
    expect(await BingWebmasterService.getStoredSnapshotForBinding(row)).toEqual(
      snapshot,
    );
    expect(getProject).not.toHaveBeenCalled();
    expect(
      await BingWebmasterService.getStoredSnapshotForBinding({
        ...row,
        bindingId: crypto.randomUUID(),
      }),
    ).toBeNull();
    expect(
      await BingWebmasterService.getStoredSnapshotForBinding({
        ...row,
        domain: "other.example.com",
      }),
    ).toBeNull();
    expect(
      await BingWebmasterService.getStoredSnapshotForBinding({
        ...row,
        organizationId: "org-b",
      }),
    ).toBeNull();
  });

  it.each(["archive", "domain", "binding"])(
    "returns null if the %s changes during a stored read",
    async (kind) => {
      await BingWebmasterService.bindSite(bindingInput);
      useMetrics();
      await BingWebmasterService.refreshSnapshot(scope);
      getObject.mockImplementationOnce(async (key) => {
        const value = objects.get(key)!;
        if (kind === "archive") getProject.mockResolvedValue(null);
        if (kind === "domain")
          getProject.mockResolvedValue({
            ...project,
            domain: "new.example.com",
          });
        if (kind === "binding")
          await client.execute({
            sql: "UPDATE bing_site_bindings SET id = ?",
            args: [crypto.randomUUID()],
          });
        return {
          text: async () => value,
          size: new TextEncoder().encode(value).byteLength,
        };
      });
      const providerCalls = fetchMock.mock.calls.length;
      expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(providerCalls);
    },
  );

  it("reuses crawl stats younger than seven days and fetches them again after", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T01:00:00Z") });
    try {
      await BingWebmasterService.bindSite(bindingInput);
      const calls: string[] = [];
      fetchMock.mockImplementation(async (input) => {
        const url = providerUrl(input);
        calls.push(url.includes("GetCrawlStats") ? "crawl" : "performance");
        return Response.json({ d: [] });
      });
      await BingWebmasterService.refreshSnapshot(scope);
      expect(calls).toEqual(["performance", "crawl"]);

      vi.setSystemTime(new Date("2026-11-12T01:00:00Z"));
      await BingWebmasterService.refreshSnapshot(scope);
      expect(calls).toEqual(["performance", "crawl", "performance"]);

      vi.setSystemTime(new Date("2026-11-17T01:00:00Z"));
      await BingWebmasterService.refreshSnapshot(scope);
      expect(calls).toEqual([
        "performance",
        "crawl",
        "performance",
        "performance",
        "crawl",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
