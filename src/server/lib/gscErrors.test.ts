import { describe, expect, it } from "vitest";
import * as errors from "./gscErrors";

describe("stored Search Console failure classification", () => {
  it.each([
    ["The operation was aborted due to timeout", "transient"],
    ["fetch failed", "transient"],
    ["Search Console rate limit reached. Retry shortly.", "quota"],
    [
      "Could not mint a Search Console access token (grant revoked or expired).",
      "auth",
    ],
    ["Search Console denied access to this property", "permission"],
    [
      "Search Console denied access to this property (no verified permission, or the connection was revoked).",
      "permission",
    ],
  ])(
    "classifies legacy %s without requiring a reconnect for transient failures",
    (message, expected) => {
      expect(errors.classifyGscError?.(message)).toBe(expected);
    },
  );
});
