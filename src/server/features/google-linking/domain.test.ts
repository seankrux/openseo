import { describe, expect, it } from "vitest";
import { bareHost, gscCandidatesFor } from "./domain";

describe("bareHost", () => {
  it("normalizes URLs, sc-domain and www", () => {
    expect(bareHost("sc-domain:Example.com")).toBe("example.com");
    expect(bareHost("https://www.example.com/path?x=1")).toBe("example.com");
    expect(bareHost("http://example.com:8080/")).toBe("example.com");
    expect(bareHost("")).toBeNull();
    expect(bareHost(undefined)).toBeNull();
  });
  it("orders GSC candidates domain property first", () => {
    expect(gscCandidatesFor("a.com")[0]).toBe("sc-domain:a.com");
    expect(gscCandidatesFor("a.com")).toContain("https://www.a.com/");
  });
});
