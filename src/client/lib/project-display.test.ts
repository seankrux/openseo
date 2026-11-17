import { describe, expect, it } from "vitest";
import { projectSwitcherDisplay } from "./project-display";

describe("projectSwitcherDisplay", () => {
  it("shows domain once when name matches domain", () => {
    expect(
      projectSwitcherDisplay({
        id: "1",
        name: "example.com",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ primary: "example.com", secondary: null });
  });

  it("shows name and domain when they differ", () => {
    expect(
      projectSwitcherDisplay({
        id: "1",
        name: "Acme Corp",
        domain: "acme.com",
        locationCode: 2840,
        languageCode: "en",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({ primary: "Acme Corp", secondary: "acme.com" });
  });
});
