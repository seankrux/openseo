import { beforeEach, expect, it, vi } from "vitest";
import { getRequestedScopes } from "./googleOAuthScopes";

const { flags } = vi.hoisted(() => ({ flags: new Map<string, string>() }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => flags.get(name),
}));
beforeEach(() => flags.clear());

it.each(["gsc", "ga4"] as const)(
  "keeps %s consent read-only until the operator opts in",
  async (provider) => {
    expect(
      await getRequestedScopes({ provider, scopes: ["read-only"] }),
    ).toEqual(["read-only"]);
  },
);

it.each(["1", "true", "TRUE"])(
  "adds management scopes only for the selected provider with flag %s",
  async (flag) => {
    flags.set("GSC_OAUTH_MANAGE_SCOPES", flag);
    expect(
      await getRequestedScopes({ provider: "gsc", scopes: ["read-only"] }),
    ).toContain("https://www.googleapis.com/auth/siteverification");
    expect(
      await getRequestedScopes({ provider: "ga4", scopes: ["read-only"] }),
    ).toEqual(["read-only"]);
  },
);
