import { describe, expect, it, vi } from "vitest";
import {
  bindingInput,
  client,
  fetchMock,
  getProject,
  getMembership,
  getObject,
  project,
  scope,
  settings,
  useMetrics,
  writeHooks,
} from "./bing-test-support";
import { BingWebmasterService } from "./BingWebmasterService";

describe("installed Bing workspace connection", () => {
  it("connects the trusted local delegated owner without a member row", async () => {
    getMembership.mockResolvedValue(null);
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).resolves.toMatchObject({
      organizationId: "delegated-local-admin",
      connectedByUserId: "local-admin",
      siteUrl: "https://example.com/",
    });
    expect(getMembership).not.toHaveBeenCalled();
  });

  it("omits stored optional evidence without project or storage access after switching to hosted mode", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    await BingWebmasterService.refreshSnapshot(scope);
    settings.AUTH_MODE = "hosted";
    getProject.mockClear();
    getObject.mockClear();
    fetchMock.mockClear();
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
    expect(getProject).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forbids refreshing a legacy binding after switching to hosted mode", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    settings.AUTH_MODE = "hosted";
    getProject.mockClear();
    fetchMock.mockClear();
    await expect(
      BingWebmasterService.refreshSnapshot(scope),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getProject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical local identity before project or provider access", async () => {
    await client.execute("INSERT INTO user VALUES ('other-user')");
    await expect(
      BingWebmasterService.bindSite({ ...bindingInput, userId: "other-user" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getProject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disconnects offline and makes old snapshots inaccessible without provider calls", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    await BingWebmasterService.refreshSnapshot(scope);
    settings.BING_WEBMASTER_ENABLED = "false";
    vi.stubEnv("BING_WEBMASTER_ENABLED", "false");
    fetchMock.mockClear();
    getObject.mockClear();
    await BingWebmasterService.disconnect(bindingInput);
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
    expect(getObject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("installed Bing status and site picker", () => {
  it.each(["disabled", "missing-key"])(
    "reports stored connection separately from %s provider availability without discovery",
    async (unavailable) => {
      const binding = await BingWebmasterService.bindSite(bindingInput);
      if (unavailable === "disabled") {
        settings.BING_WEBMASTER_ENABLED = "false";
        vi.stubEnv("BING_WEBMASTER_ENABLED", "false");
      } else {
        settings.BING_WEBMASTER_API_KEY = "";
        vi.stubEnv("BING_WEBMASTER_API_KEY", " ");
      }
      fetchMock.mockClear();
      expect(await BingWebmasterService.getConnection(scope)).toEqual({
        connected: true,
        connectorAvailable: false,
        siteUrl: "https://example.com/",
        connectedAt: binding.createdAt,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("lists only unambiguous verified canonical sites compatible with this project", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        d: [
          { Url: "https://example.com/", IsVerified: true },
          { Url: "https://foreign.com/", IsVerified: true },
          { Url: "http://example.com/", IsVerified: true },
          { Url: "http://example.com/", IsVerified: false },
          { Url: "https://example.com/path/", IsVerified: true },
          { Url: "https://example.com:443/", IsVerified: true },
        ],
      }),
    );
    expect(await BingWebmasterService.listSites(bindingInput)).toEqual({
      sites: [{ siteUrl: "https://example.com/", isSelected: false }],
    });
  });
});

describe("installed Bing discovery and disconnect races", () => {
  it("marks the exact stored selected property without storing discovery", async () => {
    const binding = await BingWebmasterService.bindSite(bindingInput);
    expect(await BingWebmasterService.listSites(bindingInput)).toEqual({
      sites: [{ siteUrl: bindingInput.siteUrl, isSelected: true }],
    });
    expect(
      (await client.execute("SELECT id FROM bing_site_bindings")).rows,
    ).toEqual([{ id: binding.id }]);
  });

  it("rejects project host changes during site discovery", async () => {
    getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValue({ ...project, domain: "changed.com" });
    await expect(
      BingWebmasterService.listSites(bindingInput),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rechecks runtime authorization after site discovery", async () => {
    fetchMock.mockImplementation(async () => {
      settings.AUTH_MODE = "hosted";
      return Response.json({
        d: [{ Url: bindingInput.siteUrl, IsVerified: true }],
      });
    });
    await expect(
      BingWebmasterService.listSites(bindingInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a conflict rather than disconnecting a replacement binding", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    writeHooks.beforeWrite = async () => {
      await client.execute(
        "UPDATE bing_site_bindings SET id = 'replacement-binding' WHERE project_id = 'project-a'",
      );
    };
    await expect(
      BingWebmasterService.disconnect(bindingInput),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await client.execute("SELECT id FROM bing_site_bindings")).rows,
    ).toEqual([{ id: "replacement-binding" }]);
  });

  it("disconnect is idempotent and does not need a provider key", async () => {
    settings.BING_WEBMASTER_API_KEY = "";
    vi.stubEnv("BING_WEBMASTER_API_KEY", " ");
    await expect(
      BingWebmasterService.disconnect(bindingInput),
    ).resolves.toBeUndefined();
    await expect(BingWebmasterService.getConnection(scope)).resolves.toEqual({
      connected: false,
      connectorAvailable: false,
      siteUrl: null,
      connectedAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects hosted binding before project or provider access even with an owner membership", async () => {
    settings.AUTH_MODE = "hosted";
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getProject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
