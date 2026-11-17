import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import { requireDataforseoApiKey } from "./config";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getRequiredEnvValue).mockResolvedValue("configured-key");
});

describe("DataForSEO configuration", () => {
  it("retains the configured provider credential", async () => {
    await expect(requireDataforseoApiKey()).resolves.toBe("configured-key");
    expect(getRequiredEnvValue).toHaveBeenCalledWith("DATAFORSEO_API_KEY");
  });

  it("reports a missing measured-data provider as a configuration error", async () => {
    vi.mocked(getRequiredEnvValue).mockRejectedValue(
      new Error("Missing required environment variable: DATAFORSEO_API_KEY"),
    );
    await expect(requireDataforseoApiKey()).rejects.toMatchObject({
      code: "DATAFORSEO_NOT_CONFIGURED",
    });
  });

  it("does not treat whitespace as a configured credential", async () => {
    vi.mocked(getRequiredEnvValue).mockResolvedValue("   ");
    await expect(requireDataforseoApiKey()).rejects.toMatchObject({
      code: "DATAFORSEO_NOT_CONFIGURED",
    });
  });

  it("preserves unrelated environment failures", async () => {
    const error = new Error("Environment binding failed");
    vi.mocked(getRequiredEnvValue).mockRejectedValue(error);
    await expect(requireDataforseoApiKey()).rejects.toBe(error);
  });
});
