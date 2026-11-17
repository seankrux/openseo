import { describe, expect, it } from "vitest";
import { classifyDomainHealth } from "./classify";
import type { DnsResult, HttpsResult } from "./types";

const dns: DnsResult = {
  ok: true,
  a: ["1.2.3.4"],
  aaaa: [],
  ns: [],
  onCloudflare: true,
  error: null,
};
function https(bodySnippet: string, status = 200): HttpsResult {
  return {
    ok: true,
    status,
    bodySnippet,
    timedOut: false,
    sslError: false,
    redirectedOtherDomain: false,
    finalUrl: "https://example.com/",
    redirectHops: 0,
    responseTimeMs: 10,
    error: null,
  };
}

describe("classifyDomainHealth blank pages", () => {
  it("classifies an empty 200 body as blank_page, not live_ok", () => {
    expect(classifyDomainHealth({ dns, https: https("") }).class).toBe(
      "blank_page",
    );
    expect(
      classifyDomainHealth({
        dns,
        https: https("<html><head></head><body>\n</body></html>"),
      }).class,
    ).toBe("blank_page");
  });

  it("keeps a real page live_ok", () => {
    const page =
      "<html><head><title>Graham Foundation Repair</title></head><body><h1>Foundation repair in Graham, TX</h1><p>Call us today.</p></body></html>";
    expect(classifyDomainHealth({ dns, https: https(page) }).class).toBe(
      "live_ok",
    );
  });

  it("keeps a script-rendered shell live_ok", () => {
    const spa =
      '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
    expect(classifyDomainHealth({ dns, https: https(spa) }).class).toBe(
      "live_ok",
    );
  });

  it("still reports http_error before blank_page", () => {
    expect(classifyDomainHealth({ dns, https: https("", 404) }).class).toBe(
      "http_error",
    );
  });
});
