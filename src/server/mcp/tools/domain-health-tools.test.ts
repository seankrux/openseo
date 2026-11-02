import { describe, expect, it, vi, beforeEach } from "vitest";
import { detectAnalyticsTags } from "@/server/lib/domain-health/detect-tags";
import { classifyDomainHealth } from "@/server/lib/domain-health/classify";

// Tool handlers need full MCP auth + db; cover the checker contracts the
// tools call so wiring regressions surface without booting the server.

describe("domain_health tool contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checker class set matches MCP enum expectations", () => {
    const dns = {
      ok: true,
      a: ["1.1.1.1"],
      aaaa: [],
      ns: [],
      onCloudflare: false,
      error: null,
    };
    const https = {
      ok: false,
      finalUrl: "https://x.test/",
      status: 522,
      redirectHops: 0,
      redirectedOtherDomain: false,
      responseTimeMs: 10,
      bodySnippet: "Error code 522",
      error: null,
      timedOut: false,
      sslError: false,
    };
    expect(classifyDomainHealth({ dns, https }).class).toBe("cf_error");
  });

  it("GA4 detection used by recheck_domain", () => {
    expect(
      detectAnalyticsTags(
        '<script src="https://www.googletagmanager.com/gtag/js?id=G-ZZ99"></script>',
      ).ga4Ids,
    ).toEqual(["G-ZZ99"]);
  });
});
