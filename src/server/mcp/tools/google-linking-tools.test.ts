import { beforeEach, expect, it, vi } from "vitest";
import {
  autoLinkGooglePropertiesTool,
  linkGa4PropertyTool,
  linkGscPropertyTool,
} from "./google-linking-tools";
import { makeToolContext } from "./tool-test-support";

const { service } = vi.hoisted(() => ({
  service: { linkGsc: vi.fn(), linkGa4: vi.fn(), autoLink: vi.fn() },
}));
vi.mock("@/server/features/google-linking/GoogleLinkingService", () => ({
  GoogleLinkingService: service,
}));
beforeEach(() => {
  service.autoLink.mockResolvedValue({ summary: {}, rows: [] });
});
const context = makeToolContext({ role: "member" });
it.each([
  [
    "GSC",
    () =>
      linkGscPropertyTool.handler(
        { projectId: "project", siteUrl: "sc-domain:example.com" },
        context,
      ),
  ],
  [
    "GA4",
    () =>
      linkGa4PropertyTool.handler(
        { projectId: "project", propertyId: "properties/123" },
        context,
      ),
  ],
  [
    "bulk",
    () => autoLinkGooglePropertiesTool.handler({ dryRun: false }, context),
  ],
] as const)(
  "denies %s integration writes to members before service access",
  async (_, action) => {
    expect((await action()).structuredContent).toMatchObject({
      ok: false,
      error: "Your organization role does not allow this action.",
    });
    expect(service.linkGsc).not.toHaveBeenCalled();
    expect(service.linkGa4).not.toHaveBeenCalled();
    expect(service.autoLink).not.toHaveBeenCalled();
  },
);
it("allows members to preview proposed links without writing", async () => {
  expect(
    (await autoLinkGooglePropertiesTool.handler({ dryRun: true }, context))
      .structuredContent,
  ).toMatchObject({ ok: true, dryRun: true });
});
