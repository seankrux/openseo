import { describe, expect, it } from "vitest";
import { analyzeHtml } from "./page-analyzer";
import {
  citySlugFromPath,
  hasLocalBusinessSchema,
  isMalformedTel,
  isPhoneLikeHref,
  otherCityRefs,
} from "./local-signals";

describe("local signals", () => {
  it("detects phone-like hrefs and malformed tel links", () => {
    expect(isPhoneLikeHref("/+1-580-271-9887”")).toBe(true);
    expect(isPhoneLikeHref("/+1-580-271-9887%E2%80%9D")).toBe(true);
    expect(isPhoneLikeHref("(580) 271-9887")).toBe(true);
    expect(isPhoneLikeHref("/services/")).toBe(false);
    expect(isPhoneLikeHref("tel:+15802719887")).toBe(false);
    expect(isMalformedTel("tel:+15802719887")).toBe(false);
    expect(isMalformedTel("tel:(580) 271-9887")).toBe(false);
    expect(isMalformedTel("tel:555")).toBe(true);
    expect(isMalformedTel("tel:+1-580-271-9887”")).toBe(true);
  });

  it("finds other-city slugs not in the domain", () => {
    expect(citySlugFromPath("/house-raising-lifting-boca-raton-fl")).toEqual({ words: ["lifting", "boca", "raton"], state: "fl" });
    expect(citySlugFromPath("/foundation-repair-in-arcadia-fl/")).toEqual({ words: ["arcadia"], state: "fl" });
    expect(citySlugFromPath("/about-us/")).toBeNull();
    expect(otherCityRefs(["/house-raising-lifting-boca-raton-fl"], "grandprairiefoundationrepairpros.com")).toEqual(["lifting-boca-raton-fl"]);
    expect(otherCityRefs(["/foundation-repair-in-leesburg-fl/"], "lrefoundationrepairofleesburg.com")).toEqual([]);
    expect(otherCityRefs(["/crawl-space-repair-grand-prairie-tx"], "www.grandprairiefoundationrepairpros.com")).toEqual([]);
  });

  it("recognizes LocalBusiness subtypes", () => {
    expect(hasLocalBusinessSchema(["WebSite", "HomeAndConstructionBusiness"])).toBe(true);
    expect(hasLocalBusinessSchema(["https://schema.org/Plumber"])).toBe(true);
    expect(hasLocalBusinessSchema(["WebSite", "WebPage", "BreadcrumbList"])).toBe(false);
  });

  it("analyzer extracts tel, callrail and schema types", () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["LocalBusiness","RoofingContractor"]}]}</script>
      <script src="//cdn.callrail.com/companies/1/swap.js"></script></head>
      <body><a href="tel:+15802719887">Call</a><a href="/+1-580-271-9887”">Bad</a><a href="/roof-repair-in-tulsa-ok/">x</a></body></html>`;
    const a = analyzeHtml(html, "https://example.com/", 200, 10);
    expect(a.local?.telHrefs).toEqual(["tel:+15802719887"]);
    expect(a.local?.phoneLikeHrefs).toEqual(["/+1-580-271-9887”"]);
    expect(a.local?.callrail).toBe(true);
    expect(a.local?.schemaTypes).toEqual(expect.arrayContaining(["LocalBusiness", "RoofingContractor", "WebSite"]));
    expect(a.local?.linkPaths).toContain("/roof-repair-in-tulsa-ok/");
  });

  it("detects inline CallRail", () => {
    const a = analyzeHtml(`<html><body><script>var x="https://cdn.callrail.com/x/swap.js"</script></body></html>`, "https://e.com/", 200, 1);
    expect(a.local?.callrail).toBe(true);
  });
});
