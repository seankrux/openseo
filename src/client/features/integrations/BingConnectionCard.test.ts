import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { getBingConnection } from "@/serverFunctions/bing";
import { BingConnectionCard } from "./BingConnectionCard";

vi.mock("@/serverFunctions/bing", () => ({
  getBingConnection: vi.fn(),
  listBingSites: vi.fn(),
  setBingSite: vi.fn(),
  disconnectBing: vi.fn(),
}));

const projectId = "project-a";
const siteUrl = "https://example.com/";

function renderSnapshot(data?: Awaited<ReturnType<typeof getBingConnection>>) {
  const client = new QueryClient();
  if (data) client.setQueryData(["bingConnection", projectId], data);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(BingConnectionCard, { projectId }),
    ),
  );
  client.clear();
  return html;
}

it("renders a loading state without connection actions", () => {
  const html = renderSnapshot();
  expect(html).toContain("Loading Bing connection");
  expect(html).not.toContain("Connect Bing");
});

it("preserves a viewer's saved connection without offering management actions", () => {
  const html = renderSnapshot({
    connected: true,
    siteUrl,
    canManage: false,
    connectorAvailable: true,
    connectedAt: null,
  });
  expect(html).toMatch(/>Connected</);
  expect(html).toContain(siteUrl);
  expect(html).toContain("Ask an organization owner or admin");
  expect(html).not.toContain("Change site");
  expect(html).not.toContain("Disconnect");
});
