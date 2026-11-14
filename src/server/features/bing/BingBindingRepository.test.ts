import { describe, expect, it } from "vitest";
import { bindingInput, client, scope, writeHooks } from "./bing-test-support";
import { BingBindingRepository } from "./BingBindingRepository";

const binding = {
  id: "binding-a",
  ...scope,
  siteUrl: bindingInput.siteUrl,
  connectedByUserId: bindingInput.userId,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

describe("Bing binding repository scoped removal on real SQLite", () => {
  it.each([
    { organizationId: "org-b" },
    { projectId: "project-b" },
    { bindingId: "a-replaced-binding" },
  ])(
    "preserves the binding when one scope component differs: %j",
    async (override) => {
      await BingBindingRepository.save(binding, "example.com");
      await BingBindingRepository.remove({
        ...scope,
        bindingId: binding.id,
        ...override,
      });
      expect(await BingBindingRepository.get(scope)).toEqual(binding);
    },
  );

  it("preserves a binding if the canonical project archives immediately before deletion", async () => {
    await BingBindingRepository.save(binding, "example.com");
    writeHooks.beforeWrite = async () => {
      await client.execute(
        "UPDATE projects SET archived_at = '2026-09-05' WHERE id = 'project-a'",
      );
    };
    await BingBindingRepository.remove({ ...scope, bindingId: binding.id });
    expect(await BingBindingRepository.get(scope)).toEqual(binding);
  });

  it("preserves a binding if the canonical project moves just before deletion", async () => {
    await BingBindingRepository.save(binding, "example.com");
    writeHooks.beforeWrite = async () => {
      await client.execute(
        "UPDATE projects SET organization_id = 'org-b' WHERE id = 'project-a'",
      );
    };
    await BingBindingRepository.remove({ ...scope, bindingId: binding.id });
    expect(await BingBindingRepository.get(scope)).toEqual(binding);
  });

  it("does not remove a replacement binding installed immediately before deletion", async () => {
    await BingBindingRepository.save(binding, "example.com");
    writeHooks.beforeWrite = async () => {
      await client.execute(
        "UPDATE bing_site_bindings SET id = 'replacement-binding' WHERE id = 'binding-a'",
      );
    };
    await BingBindingRepository.remove({ ...scope, bindingId: binding.id });
    expect(await BingBindingRepository.get(scope)).toEqual({
      ...binding,
      id: "replacement-binding",
    });
  });

  it("removes the matching scoped binding", async () => {
    await BingBindingRepository.save(binding, "example.com");
    await BingBindingRepository.remove({ ...scope, bindingId: binding.id });
    expect(await BingBindingRepository.get(scope)).toBeNull();
  });
});
