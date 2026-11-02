import { expect, test, type Page } from "@playwright/test";
import {
  browserBundle,
  connection,
  projectId,
  renderCard,
  siteUrl,
} from "./bing-connection-card-harness";

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name });
let bundle: string;

test.beforeAll(async () => {
  bundle = await browserBundle();
});

function deferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

test("opens verified-site selection only after Connect Bing and saves the chosen site", async ({
  page,
}) => {
  const api = await renderCard(page, bundle);
  await expect(
    page.getByRole("heading", { name: "Bing Webmaster Tools" }),
  ).toBeVisible();
  await expect(
    page.getByText("Use the Bing connection installed for this workspace."),
  ).toBeVisible();
  await expect(button(page, "Connect Bing")).toBeEnabled();
  expect(api.calls.listBingSites).toEqual([]);
  await button(page, "Connect Bing").click();
  await expect(
    page.getByRole("group", { name: "Verified Bing sites" }),
  ).toBeVisible();
  await expect(button(page, "Save site")).toBeDisabled();
  await page.getByText(siteUrl, { exact: true }).click();
  await button(page, "Save site").click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText(siteUrl, { exact: true })).toBeVisible();
  expect(api.calls.setBingSite).toContainEqual({
    data: { projectId, siteUrl },
  });
});

test("changes a connected site only after an explicit selection and save", async ({
  page,
}) => {
  const nextSite = "https://next.example.com/";
  const api = await renderCard(
    page,
    bundle,
    connection({ connected: true, siteUrl }),
  );
  api.listBingSites = async () => ({
    sites: [
      { siteUrl, isSelected: true },
      { siteUrl: nextSite, isSelected: false },
    ],
  });
  expect(api.calls.listBingSites).toEqual([]);
  await button(page, "Change site").click();
  await page.getByText(nextSite, { exact: true }).click();
  await button(page, "Cancel").click();
  await expect(page.getByText(siteUrl, { exact: true })).toBeVisible();
  expect(api.calls.setBingSite).toEqual([]);
  await button(page, "Change site").click();
  await expect(button(page, "Save site")).toBeDisabled();
  await page.getByText(nextSite, { exact: true }).click();
  await button(page, "Save site").click();
  await expect(page.getByText(nextSite, { exact: true })).toBeVisible();
  await expect(page.getByText(siteUrl, { exact: true })).toHaveCount(0);
  expect(api.calls.setBingSite).toContainEqual({
    data: { projectId, siteUrl: nextSite },
  });
});

test("allows an authorized disconnect without a configured connector or any site discovery", async ({
  page,
}) => {
  const api = await renderCard(
    page,
    bundle,
    connection({ connected: true, siteUrl, connectorAvailable: false }),
  );
  await expect(page.getByText("Setup required", { exact: true })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText(siteUrl, { exact: true })).toBeVisible();
  await expect(button(page, "Change site")).toHaveCount(0);
  await button(page, "Disconnect").click();
  await expect(page.getByText(siteUrl, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Setup required", { exact: true })).toBeVisible();
  await expect(button(page, "Connect Bing")).toHaveCount(0);
  expect(api.calls.disconnectBing).toContainEqual({ data: { projectId } });
  expect(api.calls.listBingSites).toEqual([]);
});

test("retries a failed connection check before enabling Connect Bing", async ({
  page,
}) => {
  const api = await renderCard(page, bundle, connection(), (mockApi) => {
    const read = mockApi.getBingConnection;
    mockApi.getBingConnection = async () => {
      mockApi.getBingConnection = read;
      throw new Error("Connection check failed");
    };
  });
  await expect(page.getByRole("alert")).toContainText(
    "Connection check failed",
  );
  await expect(button(page, "Connect Bing")).toHaveCount(0);
  await button(page, "Try again").click();
  await expect(button(page, "Connect Bing")).toBeEnabled();
  expect(api.calls.listBingSites).toEqual([]);
});

test("retries discovery errors and refreshes an empty verified-site list", async ({
  page,
}) => {
  const api = await renderCard(page, bundle);
  const discover = api.listBingSites;
  let attempts = 0;
  api.listBingSites = (args) => {
    attempts++;
    if (attempts === 1)
      return Promise.reject(new Error("Sites could not be loaded"));
    if (attempts === 2) return Promise.resolve({ sites: [] });
    return discover(args);
  };
  await button(page, "Connect Bing").click();
  await expect(page.getByRole("alert")).toContainText(
    "Sites could not be loaded",
  );
  await expect(button(page, "Save site")).toBeDisabled();
  await button(page, "Try again").click();
  await expect(page.getByText(/No verified sites are available/)).toBeVisible();
  await expect(button(page, "Save site")).toBeDisabled();
  await button(page, "Refresh sites").click();
  await expect(page.getByText(siteUrl, { exact: true })).toBeVisible();
});

test("disables pending saves and retains the chosen site after a save failure", async ({
  page,
}) => {
  const api = await renderCard(page, bundle);
  const pending = deferred();
  const save = api.setBingSite;
  api.setBingSite = () => {
    api.setBingSite = save;
    return pending.promise;
  };
  await button(page, "Connect Bing").click();
  await page.getByText(siteUrl, { exact: true }).click();
  await button(page, "Save site").click();
  await expect(button(page, "Save site")).toBeDisabled();
  await expect(button(page, "Cancel")).toBeDisabled();
  await expect(
    page.getByRole("radio", { name: siteUrl, exact: true }),
  ).toBeDisabled();
  pending.reject(new Error("This site could not be saved"));
  await expect(page.getByRole("alert")).toContainText(
    "This site could not be saved",
  );
  await expect(
    page.getByRole("radio", { name: siteUrl, exact: true }),
  ).toBeChecked();
  await button(page, "Save site").click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});

test("keeps the saved site after a failed disconnect and allows retry", async ({
  page,
}) => {
  const api = await renderCard(
    page,
    bundle,
    connection({ connected: true, siteUrl }),
  );
  const pending = deferred();
  const disconnect = api.disconnectBing;
  api.disconnectBing = () => {
    api.disconnectBing = disconnect;
    return pending.promise;
  };
  await button(page, "Disconnect").click();
  await expect(
    page.getByRole("button", { name: /Disconnect$/ }),
  ).toBeDisabled();
  await expect(button(page, "Change site")).toBeDisabled();
  pending.reject(new Error("This site could not be disconnected"));
  await expect(page.getByRole("alert")).toContainText(
    "This site could not be disconnected",
  );
  await expect(page.getByText(siteUrl, { exact: true })).toBeVisible();
  await button(page, "Disconnect").click();
  await expect(button(page, "Connect Bing")).toBeEnabled();
  await expect(page.getByText(siteUrl, { exact: true })).toHaveCount(0);
  expect(api.calls.listBingSites).toEqual([]);
});

test("clears the open picker and unsaved selection when the project changes", async ({
  page,
}) => {
  const api = await renderCard(page, bundle);
  await button(page, "Connect Bing").click();
  await page.getByText(siteUrl, { exact: true }).click();
  await page.evaluate(() => window.renderBing("project-b"));
  await expect(button(page, "Connect Bing")).toBeEnabled();
  await expect(
    page.getByRole("group", { name: "Verified Bing sites" }),
  ).toHaveCount(0);
  expect(api.calls.listBingSites).toHaveLength(1);
  await button(page, "Connect Bing").click();
  await expect(
    page.getByRole("radio", { name: siteUrl, exact: true }),
  ).not.toBeChecked();
  await expect(button(page, "Save site")).toBeDisabled();
  expect(api.calls.listBingSites.at(-1)).toEqual({
    data: { projectId: "project-b" },
  });
});
