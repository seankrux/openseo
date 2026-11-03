import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { getBingConnection } from "../src/serverFunctions/bing";

type BingConnection = Awaited<ReturnType<typeof getBingConnection>>;
type ApiArgs = { data: { projectId: string; siteUrl?: string } };
type ApiMethod =
  | "getBingConnection"
  | "listBingSites"
  | "setBingSite"
  | "disconnectBing";

declare global {
  interface Window {
    renderBing: (projectId: string) => void;
  }
}

export const projectId = "project-a";
export const siteUrl = "https://example.com/";
export const connection = (
  overrides: Partial<BingConnection> = {},
): BingConnection => ({
  connected: false,
  canManage: true,
  connectorAvailable: true,
  siteUrl: null,
  connectedAt: null,
  ...overrides,
});

// Bundle only the real card tree in memory. No app config, env file, output
// artifacts or server are used; only the server-function boundary is replaced.
export async function browserBundle() {
  const entry = "virtual:bing-card-test";
  const api = "virtual:bing-api";
  const result = await build({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    envDir: false,
    logLevel: "silent",
    publicDir: false,
    define: { "import.meta.env.AUTH_MODE": JSON.stringify("local_noauth") },
    resolve: {
      alias: [
        { find: "@/serverFunctions/bing", replacement: api },
        {
          find: "@",
          replacement: fileURLToPath(new URL("../src", import.meta.url)),
        },
      ],
    },
    plugins: [
      {
        name: "bing-card-test",
        resolveId: (id) => (id === entry || id === api ? `\0${id}` : null),
        load(id) {
          if (id === `\0${api}`)
            return [
              "getBingConnection",
              "listBingSites",
              "setBingSite",
              "disconnectBing",
            ]
              .map(
                (name) =>
                  `export const ${name} = (args) => window.bingApi("${name}", args);`,
              )
              .join("\n");
          if (id === `\0${entry}`)
            return `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
          import { BingConnectionCard } from "@/client/features/integrations/BingConnectionCard";
          const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
          const root = createRoot(document.getElementById("root"));
          window.renderBing = (projectId) => root.render(createElement(QueryClientProvider, { client }, createElement(BingConnectionCard, { projectId })));
        `;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: entry,
        output: {
          format: "iife",
          name: "BingCardTest",
          inlineDynamicImports: true,
        },
      },
    },
  });
  if (Array.isArray(result) || !("output" in result))
    throw new Error("Expected a single test bundle");
  const chunk = result.output.find((output) => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Missing test bundle");
  return chunk.code;
}

function createApi(initial: BingConnection) {
  let stored = initial;
  const calls: Record<ApiMethod, ApiArgs[]> = {
    getBingConnection: [],
    listBingSites: [],
    setBingSite: [],
    disconnectBing: [],
  };
  return {
    calls,
    getBingConnection: async (_args: ApiArgs) => stored,
    listBingSites: async (_args: ApiArgs) => ({
      sites: [{ siteUrl, isSelected: false }],
    }),
    setBingSite: async (args: ApiArgs) => {
      stored = {
        ...stored,
        connected: true,
        siteUrl: args.data.siteUrl ?? null,
        connectedAt: "2026-07-01T00:00:00Z",
      };
      return {
        connected: true,
        siteUrl: stored.siteUrl,
        connectedAt: stored.connectedAt,
      };
    },
    disconnectBing: async (_args: ApiArgs) => {
      stored = {
        ...stored,
        connected: false,
        siteUrl: null,
        connectedAt: null,
      };
      return { connected: false };
    },
  };
}

export async function renderCard(
  page: Page,
  bundle: string,
  initial = connection(),
  prepare?: (api: ReturnType<typeof createApi>) => void,
) {
  const api = createApi(initial);
  prepare?.(api);
  await page.context().route("**/*", (route) => route.abort());
  await page.context().routeWebSocket("**/*", (socket) => socket.close());
  await page.exposeFunction("bingApi", (name: ApiMethod, args: ApiArgs) => {
    api.calls[name].push(args);
    return api[name](args);
  });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate((id) => window.renderBing(id), projectId);
  return api;
}
