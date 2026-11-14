import { beforeEach, describe, expect, it, vi } from "vitest";
import { rankFromOrganicSerp, resolveSerpProvider } from "./serp-provider";

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => env.values[name],
}));

describe("resolveSerpProvider", () => {
  beforeEach(() => {
    env.values = {};
  });

  it("prefers DataForSEO when both keys are set", async () => {
    env.values = { DATAFORSEO_API_KEY: "dfs", SEMRUSH_API_KEY: "sem" };
    expect(await resolveSerpProvider()).toEqual({ kind: "dataforseo" });
  });

  it("uses Semrush when only its key is set", async () => {
    env.values = { DATAFORSEO_API_KEY: "  ", SEMRUSH_API_KEY: "sem" };
    expect(await resolveSerpProvider()).toMatchObject({
      kind: "semrush",
      provider: { id: "semrush" },
    });
  });

  it("is unavailable without either key", async () => {
    env.values = { SEMRUSH_API_KEY: " " };
    expect(await resolveSerpProvider()).toBeNull();
  });
});

describe("rankFromOrganicSerp", () => {
  const input = {
    keywordId: "kw_1",
    keyword: "seo",
    targetDomain: "Example.com",
  };

  it("takes the best position of the domain or a subdomain", () => {
    expect(
      rankFromOrganicSerp(input, [
        {
          position: 2,
          domain: "notexample.com",
          url: "https://notexample.com/",
        },
        {
          position: 4,
          domain: "blog.example.com",
          url: "https://blog.example.com/x",
        },
        { position: 7, domain: "example.com", url: "https://example.com/" },
      ]),
    ).toEqual({
      keywordId: "kw_1",
      keyword: "seo",
      position: 4,
      url: "https://blog.example.com/x",
      serpFeatures: [],
    });
  });

  it("reports not ranking when the domain is absent", () => {
    expect(
      rankFromOrganicSerp(input, [
        {
          position: 1,
          domain: "notexample.com",
          url: "https://notexample.com/",
        },
      ]),
    ).toMatchObject({ position: null, url: null });
  });
});
