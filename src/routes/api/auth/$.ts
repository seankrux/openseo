import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuth, hasHostedAuthConfig } from "@/lib/auth";
import { isHostedAuthMode } from "@/lib/auth-mode";

async function handleAuthRequest(request: Request) {
  if (!isHostedAuthMode(env.AUTH_MODE)) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname.endsWith("/get-session")) {
      return Response.json(null, { status: 200 });
    }
    return new Response("Not found", {
      status: 404,
    });
  }

  if (!hasHostedAuthConfig()) {
    return new Response("Missing Better Auth hosted configuration", {
      status: 500,
    });
  }

  const auth = getAuth();
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        return handleAuthRequest(request);
      },
      POST: async ({ request }: { request: Request }) => {
        return handleAuthRequest(request);
      },
    },
  },
});
