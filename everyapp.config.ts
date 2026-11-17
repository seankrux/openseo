/**
 * OpenSEO on an Every App gateway (AUTH_MODE=everyapp). The gateway signs
 * people in and decides who may open OpenSEO, serves its MCP tools on the
 * gateway's one connector, and holds the DataForSEO, Context and OpenRouter
 * keys, so a deploy needs no OpenSEO settings to open (its own two:
 * CRAWLER_ACCESS_SECRET, which the deploy generates, and OPENROUTER_MODEL,
 * an optional feature, below). See
 * docs/maintainers/every-app.md.
 *
 * D1 and KV, one organization (EVERY_APP_ORG_ID, set by the deploy).
 *
 *   pnpm dev:everyapp       # local, behind a gateway-lite with a dev user
 *   pnpm everyapp install https://github.com/every-app/open-seo
 *                           # onto your Gateway, from an Every App checkout
 */
export default {
  // Distinct from the stock `openseo` app so both can be installed.
  id: "seo-sean",
  name: "OpenSEO (Sean)",
  description: "SEO research you pay for by use, not by the month.",
  icon: "/everyapp-icon.svg",
  // wrangler.jsonc's, so every build of OpenSEO runs on the same runtime.
  compatibilityDate: "2025-09-02",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    // Bound on the app's Workers; the audit helper uses it for "Render JavaScript".
    browser: ["BROWSER"],
    durableObjects: [
      { name: "SAM_CHAT", className: "SamChatAgent" },
      // Each audit's crawl state, private to the audit Worker.
      {
        name: "AUDIT_SCRATCHPAD",
        className: "AuditScratchpad",
        worker: "audit",
      },
    ],
    workflows: [
      { name: "RANK_CHECK_WORKFLOW", className: "RankCheckWorkflow" },
      { name: "AI_VISIBILITY_WORKFLOW", className: "AiVisibilityWorkflow" },
      { name: "LOCAL_RANK_WORKFLOW", className: "LocalRankWorkflow" },
      {
        name: "SITE_AUDIT_WORKFLOW",
        className: "SiteAuditWorkflow",
        worker: "audit",
      },
    ],
  },
  // The site-audit engine (src/audit-worker.ts), on an isolate of its own
  // as the open-seo-audit Worker elsewhere. The app reaches it through
  // AUDIT_ENGINE and SITE_AUDIT_WORKFLOW.
  workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  // `config` names the drizzle config the deploy's schema check runs
  // drizzle-kit generate with; there is no drizzle.config.ts at the root
  // (the Postgres and remote-D1 configs sit beside this one).
  migrations: {
    engine: "drizzle",
    dir: "drizzle/sqlite",
    config: "drizzle/sqlite.config.ts",
    binding: "DB",
  },
  // What the gateway must hold before OpenSEO opens. What it may hold
  // (the feature says what is missing where it is used) is listed in an
  // optional feature too, under `features`. `why` is for whoever sets it.
  // Through the gateway's AI proxy and its OPENROUTER_API_KEY.
  providers: [
    {
      id: "openrouter",
      why: "SAM, prompt suggestions and website research run on it.",
    },
  ],
  // What OpenSEO calls through the gateway with keys only the gateway holds
  // (integrationFetch). An approval covers the app; every call counts
  // against the install's organization (src/server/lib/gateway-attribution.ts).
  capabilities: {
    dataforseo: {
      access: "read",
      why: "Keyword, SERP, backlink, local business and AI answer data, including scheduled rank checks. The value is `login:password` from the DataForSEO dashboard, or its base64.",
    },
    // Audits run without it: the "Render JavaScript" option says an admin
    // sets it (src/server/lib/audit/rendering-policy.ts).
    context: {
      access: "read",
      why: "Renders JavaScript-heavy pages when a site audit asks for it.",
    },
    // The gateway holds the Google client and each member's connection to
    // OpenSEO, made from OpenSEO's Connect button; Search Console and GA4
    // reads go through it with a member's token (src/server/features/
    // google/gatewayGoogle.ts). Google's own scopes, read only; the gateway
    // adds the identity scopes and refuses a token carrying more. Without
    // a Google client the Google cards say so.
    "google-workspace": {
      scopes: ["webmasters.readonly", "analytics.readonly"],
      why: "Search Console and GA4 reads for your sites, with the Google account you connect in OpenSEO.",
    },
  },
  // OpenSEO's own, on its Workers (`pnpm everyapp secret set <NAME> --app
  // seo-sean`). The deploy generates CRAWLER_ACCESS_SECRET when it's unset.
  // OpenRouter and DataForSEO stay gateway keys (providers / capabilities).
  // New Google connections use the google-workspace capability. Imported
  // Search Console / Analytics grants still refresh with the app-owned
  // Google client and BETTER_AUTH_SECRET declared on the google feature.
  secrets: [
    {
      name: "CRAWLER_ACCESS_SECRET",
      generate: true,
      why: "Encrypts Shopify crawler-access signatures for protected-store audits.",
    },
  ],
  // Optional, each all or nothing: OpenSEO opens without them.
  features: {
    // Audits run without it: the "Render JavaScript" option says an admin
    // sets it (src/server/lib/audit/rendering-policy.ts).
    rendering: {
      name: "JavaScript rendering",
      why: "Renders JavaScript-heavy pages when a site audit asks for it.",
      steps: [
        "Create a Context account and copy its API key: https://www.context.dev",
      ],
      capabilities: ["context"],
      secrets: [
        {
          name: "AUDIT_BROWSER_RENDERING",
          how: "Set true when Browser Rendering (resources.browser) is bound so the audit form can offer Render JavaScript. Context remains an optional fallback.",
        },
      ],
    },
    // Without a Google client the Google cards say so.
    google: {
      name: "Search Console and GA4",
      why: "Search Console and GA4 reads for your sites, with the Google account each member connects in OpenSEO.",
      steps: [
        "Enable the Search Console API: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com",
        "Enable the Analytics Admin and Data APIs in Google Cloud.",
        "Create an OAuth client of type Web application: https://console.cloud.google.com/apis/credentials",
        "Redirect URI: {gatewayUrl}/connect/google-workspace/callback. Consent screen scopes: webmasters.readonly and analytics.readonly.",
      ],
      capabilities: ["google-workspace"],
      // Imported self-host grants (account table, user local-admin) refresh
      // with the original OAuth client and decrypt with this secret.
      // EveryApp mode still uses the gateway Connect button for new links.
      secrets: [
        {
          name: "BETTER_AUTH_SECRET",
          how: "Encrypts imported Google tokens (same as the self-host).",
        },
        {
          name: "GOOGLE_CLIENT_ID",
          how: "OAuth client ID for imported Google grants.",
        },
        {
          name: "GOOGLE_CLIENT_SECRET",
          how: "OAuth client secret for imported Google grants.",
        },
      ],
    },
    // Without it the default in src/server/lib/openrouter.ts is used.
    model: {
      name: "OpenRouter model",
      why: "Picks the OpenRouter model for SAM, prompt suggestions and website research instead of the default (openai/gpt-5.6-luna).",
      secrets: [
        {
          name: "OPENROUTER_MODEL",
          how: "An OpenRouter model id, e.g. openai/gpt-5.6-luna: https://openrouter.ai/models",
        },
      ],
    },
    "openrouter-proxy": {
      name: "OpenRouter-compatible proxy",
      why: "Sends SAM and research to an OpenAI-compatible base URL instead of OpenRouter. Unused behind the gateway AI proxy.",
      secrets: [
        {
          name: "OPENROUTER_BASE_URL",
          how: "Base URL of an OpenAI-compatible chat API, without a trailing path beyond /v1.",
        },
      ],
    },
    bing: {
      name: "Bing Webmaster",
      why: "Reads Bing Webmaster performance for the fleet table and project integrations.",
      settings: [
        {
          name: "BING_WEBMASTER_ENABLED",
          type: "text",
          how: "Set true to read Bing. The key alone does not turn calls on.",
        },
      ],
      secrets: [
        {
          name: "BING_WEBMASTER_API_KEY",
          how: "Bing Webmaster API key from https://www.bing.com/webmasters/apikey. It must be allowed to read every site in the fleet.",
        },
        {
          name: "BING_WEBMASTER_RELAY_URL",
          how: "HTTPS URL of the authenticated Bing Webmaster relay (Workers egress is ThrottleIP). The relay holds the API key.",
        },
        {
          name: "BING_WEBMASTER_RELAY_SECRET",
          how: "Bearer secret the Worker and the Bing Webmaster relay share. Never a Cloudflare Workers URL.",
        },
      ],
    },
    semrush: {
      name: "Semrush rank checks",
      why: "Country-level rank checks when DataForSEO access is missing. No city SERPs.",
      secrets: [
        {
          name: "SEMRUSH_API_KEY",
          how: "Semrush API key from https://www.semrush.com/accounts/subscription-info/api-units/.",
        },
      ],
    },
    "ga4-setup": {
      name: "GA4 property setup",
      why: "Creates a GA4 property and installs its tag through Cloudflare. Stays idle unless GA4_AUTOSETUP is 1.",
      settings: [
        {
          name: "GA4_SETUP_PARENT_ACCOUNT",
          how: "GA4 Admin parent, accounts/<id>.",
        },
        {
          name: "GA4_SETUP_CLOUDFLARE_ACCOUNT_ID",
          how: "Cloudflare account id that owns the fleet Workers.",
        },
        {
          name: "GA4_SETUP_GOOGLE_EMAIL",
          how: "Email of the connected Google login that should own new properties.",
        },
        {
          name: "GA4_AUTOSETUP",
          type: "text",
          how: "1 runs a small batch on the cron. Leave unset to use the tools only.",
        },
      ],
      secrets: [
        {
          name: "GA4_SETUP_CLOUDFLARE_TOKEN",
          how: "Cloudflare API token that can edit Workers routes and the tag KV namespace.",
        },
      ],
    },
    "search-console-dns": {
      name: "Search Console DNS verification",
      why: "Adds the Search Console DNS TXT record when gsc_onboard_domain runs.",
      secrets: [
        {
          name: "CLOUDFLARE_DNS_TOKEN",
          how: "Cloudflare API token with DNS edit on the zones you verify.",
        },
      ],
    },
  },
  // Both Workers, from cloudflare.config.ts and vite-plugin-every-app.ts.
  build: "pnpm build:report-widgets && AUTH_MODE=everyapp pnpm exec vite build",
  dev: "pnpm build:report-widgets && AUTH_MODE=everyapp pnpm exec vite dev --host 127.0.0.1",
  // Nothing reaches OpenSEO without a signed-in member: report sharing and
  // the other unauthenticated routes are hosted-only, and the gateway's tool
  // calls (`/__everyapp/tools/*`) carry their own gateway-signed tokens.
  // Every member opens OpenSEO once it is installed, like the other three
  // launch apps (OpenCRM, OpenAnalytics, Agentic Inbox): the documented
  // default for them. Without it a fresh install opens to owners and admins
  // only, and an admin grants the rest by hand.
  access: "everyone",
  public: [],
} as const;
