import { describe, expect, it } from "vitest";
import {
  bindingInput,
  client,
  fetchMock,
  getMembership,
  getProject,
  project,
  scope,
  settings,
  useMetrics,
  writeHooks,
} from "./bing-test-support";
import { BingWebmasterService } from "./BingWebmasterService";

describe("BingWebmasterService binding", () => {
  it.each(["org-b", "delegated-other-user"])(
    "rejects a noncanonical workspace before discovering multisite properties: %s",
    async (organizationId) => {
      await expect(
        BingWebmasterService.bindSite({ ...bindingInput, organizationId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(getProject).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://foreign.com/",
    "https://www.example.com/",
    "https://example.com/blog/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com/?private=1",
    "ftp://example.com/",
  ])("rejects noncanonical project properties: %s", async (siteUrl) => {
    fetchMock.mockResolvedValue(
      Response.json({ d: [{ Url: siteUrl, IsVerified: true }] }),
    );
    await expect(
      BingWebmasterService.bindSite({ ...bindingInput, siteUrl }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(0);
  });

  it.each([false, "duplicate"])(
    "rejects unverified or ambiguous exact properties: %s",
    async (variant) => {
      const site = {
        Url: bindingInput.siteUrl,
        IsVerified: variant === "duplicate",
      };
      fetchMock.mockResolvedValue(
        Response.json({ d: variant === "duplicate" ? [site, site] : [site] }),
      );
      await expect(
        BingWebmasterService.bindSite(bindingInput),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    },
  );

  it("rejects conflicting verification states for the same property", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        d: [
          { Url: bindingInput.siteUrl, IsVerified: true },
          { Url: bindingInput.siteUrl, IsVerified: false },
        ],
      }),
    );
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it.each([
    "https://example.com:443/",
    "https://example.com/../",
    "https://example.com/#",
    "https://example.com/?",
  ])("rejects ambiguous root URL representations: %s", async (siteUrl) => {
    fetchMock.mockResolvedValue(
      Response.json({ d: [{ Url: siteUrl, IsVerified: true }] }),
    );
    await expect(
      BingWebmasterService.bindSite({ ...bindingInput, siteUrl }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a project outside the canonical organization before provider traffic", async () => {
    getProject.mockResolvedValue(null);
    await expect(
      BingWebmasterService.bindSite({
        ...bindingInput,
        projectId: "project-b",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a binding if the project host changes during discovery", async () => {
    getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValue({ ...project, domain: "changed.com" });
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(0);
  });

  it("atomically refuses a binding when the canonical project changes immediately before its SQL write", async () => {
    writeHooks.beforeWrite = async () => {
      await client.execute(
        "UPDATE projects SET organization_id = 'org-b' WHERE id = 'project-a'",
      );
    };
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(0);
  });

  it("rotates the binding and isolates all previously stored snapshots on rebind", async () => {
    const initial = await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    await BingWebmasterService.refreshSnapshot(scope);
    fetchMock.mockImplementation(async () =>
      Response.json({ d: [{ Url: bindingInput.siteUrl, IsVerified: true }] }),
    );
    const rebound = await BingWebmasterService.bindSite(bindingInput);
    expect(rebound.id).not.toBe(initial.id);
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(1);
    expect(await BingWebmasterService.getStoredSnapshot(scope)).toBeNull();
  });

  it("preserves a prior binding when verification fails", async () => {
    const binding = await BingWebmasterService.bindSite(bindingInput);
    fetchMock.mockResolvedValue(Response.json({ d: [] }));
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      (await client.execute("SELECT id FROM bing_site_bindings")).rows[0]?.id,
    ).toBe(binding.id);
  });

  it("rechecks trusted runtime workspace after discovery before persisting a binding", async () => {
    fetchMock.mockImplementation(async () => {
      settings.AUTH_MODE = "hosted";
      return Response.json({
        d: [{ Url: bindingInput.siteUrl, IsVerified: true }],
      });
    });
    await expect(
      BingWebmasterService.bindSite(bindingInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(0);
  });

  it("enforces project uniqueness and cascading relational references", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    const row = (
      id: string,
      projectId: string,
      organizationId: string,
      userId: string,
    ) =>
      client.execute({
        sql: "INSERT INTO bing_site_bindings VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          projectId,
          organizationId,
          bindingInput.siteUrl,
          userId,
          "2026-09-05",
          "2026-09-05",
        ],
      });
    await expect(
      row("duplicate", "project-a", scope.organizationId, bindingInput.userId),
    ).rejects.toThrow();
    await expect(
      row(
        "missing-project",
        "absent",
        scope.organizationId,
        bindingInput.userId,
      ),
    ).rejects.toThrow();
    await expect(
      row("missing-org", "project-b", "absent", bindingInput.userId),
    ).rejects.toThrow();
    await expect(
      row("missing-user", "project-b", "org-b", "absent"),
    ).rejects.toThrow();
    await client.execute("DELETE FROM projects WHERE id = 'project-a'");
    expect(
      (await client.execute("SELECT * FROM bing_site_bindings")).rows,
    ).toHaveLength(0);
  });

  it("binds only a verified exact site to the canonical owner-scoped project", async () => {
    const binding = await BingWebmasterService.bindSite(bindingInput);
    expect(binding).toMatchObject({
      ...scope,
      siteUrl: bindingInput.siteUrl,
      connectedByUserId: bindingInput.userId,
    });
    const { rows } = await client.execute("SELECT * FROM bing_site_bindings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: scope.projectId,
      organization_id: scope.organizationId,
      site_url: bindingInput.siteUrl,
    });
    expect(JSON.stringify(rows)).not.toContain("do-not-store");
    expect(getMembership).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
