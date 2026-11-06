import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoogleConnectedState } from "./GoogleConnectedState";

describe("linked Google property recovery", () => {
  it.each([true, false])(
    "offers explicit reconnection only to project managers (%s)",
    (canManage) => {
      const html = renderToStaticMarkup(
        createElement(GoogleConnectedState, {
          property: "Example property",
          onChange: vi.fn(),
          onDisconnect: vi.fn(),
          onReconnect: vi.fn(),
          disconnecting: false,
          disabled: false,
          canManage,
          canManageAccounts: true,
        }),
      );
      expect(html.includes("Reconnect Google account")).toBe(canManage);
    },
  );
});
