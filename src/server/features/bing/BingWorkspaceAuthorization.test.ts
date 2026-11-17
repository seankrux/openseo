import { describe, expect, it } from "vitest";
import {
  bindingInput,
  client,
  fetchMock,
  getMembership,
  getObject,
  getProject,
  project,
  scope,
  settings,
  useMetrics,
  withPgClient,
} from "./bing-test-support";
import { BingSnapshotStore } from "./BingSnapshotStore";
import { BingWebmasterService } from "./BingWebmasterService";

const actions = [
  [
    "bind",
    (input: typeof bindingInput) => BingWebmasterService.bindSite(input),
  ],
  [
    "discover",
    (input: typeof bindingInput) => BingWebmasterService.listSites(input),
  ],
  [
    "disconnect",
    (input: typeof bindingInput) => BingWebmasterService.disconnect(input),
  ],
  [
    "status",
    (input: typeof bindingInput) => BingWebmasterService.getConnection(input),
  ],
  [
    "refresh",
    (input: typeof bindingInput) => BingWebmasterService.refreshSnapshot(input),
  ],
] as const;

const deniedWorkspaces = [
  ["hosted", scope.organizationId],
  ["unknown", scope.organizationId],
  ["", scope.organizationId],
  ["LOCAL_NOAUTH", scope.organizationId],
  ["local_noauth", "shared-workspace"],
  ["local_noauth", "org-b"],
  ["cloudflare_access", scope.organizationId],
  ["cloudflare_access", "org-b"],
] as const;

describe.each(deniedWorkspaces)(
  "installed Bing runtime %s / workspace %s",
  (mode, organizationId) => {
    it.each(actions)(
      "forbids %s before database or upstream access",
      async (_, action) => {
        settings.AUTH_MODE = mode;
        await expect(
          action({ ...bindingInput, organizationId }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(withPgClient).not.toHaveBeenCalled();
        expect(getProject).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getObject).not.toHaveBeenCalled();
      },
    );

    it("omits optional stored evidence before database or object storage access", async () => {
      settings.AUTH_MODE = mode;
      expect(
        await BingWebmasterService.getStoredSnapshot({
          ...scope,
          organizationId,
        }),
      ).toBeNull();
      expect(withPgClient).not.toHaveBeenCalled();
      expect(getProject).not.toHaveBeenCalled();
      expect(getObject).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  },
);

describe("canonical Access Bing connection", () => {
  it("supports the shared workspace owner without hosted membership rows", async () => {
    settings.AUTH_MODE = "cloudflare_access";
    const organizationId = "shared-workspace";
    await client.execute(
      "INSERT INTO organization VALUES ('shared-workspace')",
    );
    await client.execute("INSERT INTO user VALUES ('verified-access-subject')");
    await client.execute(
      "UPDATE projects SET organization_id = 'shared-workspace' WHERE id = 'project-a'",
    );
    getProject.mockResolvedValue({ ...project, organizationId });
    getMembership.mockResolvedValue(null);
    const input = {
      ...bindingInput,
      organizationId,
      userId: "verified-access-subject",
    };
    expect(await BingWebmasterService.listSites(input)).toEqual({
      sites: [{ siteUrl: bindingInput.siteUrl, isSelected: false }],
    });
    expect(await BingWebmasterService.bindSite(input)).toMatchObject({
      connectedByUserId: input.userId,
      organizationId,
    });
    useMetrics();
    const snapshot = await BingWebmasterService.refreshSnapshot(input);
    expect(await BingWebmasterService.getStoredSnapshot(input)).toEqual(
      snapshot,
    );
    await BingWebmasterService.disconnect(input);
    expect(await BingWebmasterService.getStoredSnapshot(input)).toBeNull();
    expect(getMembership).not.toHaveBeenCalled();
  });

  it("does not accept a missing authenticated Access identity", async () => {
    settings.AUTH_MODE = "cloudflare_access";
    await expect(
      BingWebmasterService.listSites({
        ...bindingInput,
        organizationId: "shared-workspace",
        userId: "",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(withPgClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("legacy installed Bing evidence", () => {
  it("does not expose a real foreign-org legacy binding and matching stored object", async () => {
    await BingWebmasterService.bindSite(bindingInput);
    useMetrics();
    const snapshot = await BingWebmasterService.refreshSnapshot(scope);
    await client.execute(
      "UPDATE projects SET organization_id = 'org-b' WHERE id = 'project-a'",
    );
    await client.execute(
      "UPDATE bing_site_bindings SET organization_id = 'org-b' WHERE project_id = 'project-a'",
    );
    await BingSnapshotStore.save({ ...snapshot, organizationId: "org-b" });
    getProject.mockResolvedValue({ ...project, organizationId: "org-b" });
    withPgClient.mockClear();
    getProject.mockClear();
    getObject.mockClear();
    fetchMock.mockClear();
    expect(
      await BingWebmasterService.getStoredSnapshot({
        ...scope,
        organizationId: "org-b",
      }),
    ).toBeNull();
    expect(withPgClient).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
