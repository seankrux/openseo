import { FREE_TOOL_PATHS } from "@/lib/free-tools/free-tool-paths";

export type FreeToolSlug = keyof typeof FREE_TOOL_PATHS;

export type FreeToolCategory = "research" | "local" | "technical";

export type FreeTool = {
  slug: FreeToolSlug;
  path: string;
  name: string;
  shortDescription: string;
  category: FreeToolCategory;
  /** The paid feature this tool is the free sample of. */
  featureHref: string;
  related: FreeToolSlug[];
};

// Spend ceilings deliberately live in spend.ts, not here — this file is
// marketing copy, and a copy edit must not be able to move a spend control.

export const freeTools = {
  "backlink-checker": {
    slug: "backlink-checker",
    path: FREE_TOOL_PATHS["backlink-checker"],
    name: "Backlink Checker",
    shortDescription:
      "Domain rank, referring domains, and the top backlinks pointing at any site.",
    category: "research",
    featureHref: "/features/backlink-checker",
    related: ["spam-score-checker", "website-traffic-checker"],
  },
  "competitor-keyword-finder": {
    slug: "competitor-keyword-finder",
    path: FREE_TOOL_PATHS["competitor-keyword-finder"],
    name: "Competitor Keyword Finder",
    shortDescription:
      "Find a competitor's top organic keywords, search volumes, positions, and ranking pages.",
    category: "research",
    featureHref: "/features/domain-overview",
    related: [
      "keyword-generator",
      "competitor-analysis",
      "website-traffic-checker",
    ],
  },
  "keyword-generator": {
    slug: "keyword-generator",
    path: FREE_TOOL_PATHS["keyword-generator"],
    name: "Keyword Generator",
    shortDescription:
      "Turn a topic into keyword ideas with search volume and difficulty estimates.",
    category: "research",
    featureHref: "/features/keyword-research",
    related: [
      "competitor-keyword-finder",
      "competitor-analysis",
      "serp-simulator",
    ],
  },
  "website-traffic-checker": {
    slug: "website-traffic-checker",
    path: FREE_TOOL_PATHS["website-traffic-checker"],
    name: "Website Traffic Checker",
    shortDescription:
      "Estimated organic traffic, keyword count, top keywords, and top pages for any domain.",
    category: "research",
    featureHref: "/features/domain-overview",
    related: [
      "competitor-analysis",
      "competitor-keyword-finder",
      "backlink-checker",
    ],
  },
  "competitor-analysis": {
    slug: "competitor-analysis",
    path: FREE_TOOL_PATHS["competitor-analysis"],
    name: "Competitor Analysis",
    shortDescription:
      "A competitor's top keywords and pages, and the keywords they rank for that you don't.",
    category: "research",
    featureHref: "/features/domain-overview",
    related: [
      "website-traffic-checker",
      "competitor-keyword-finder",
      "backlink-checker",
    ],
  },
  "spam-score-checker": {
    slug: "spam-score-checker",
    path: FREE_TOOL_PATHS["spam-score-checker"],
    name: "Spam Score Checker",
    shortDescription:
      "A domain's backlink spam score and the spammiest links pointing at it.",
    category: "research",
    featureHref: "/features/backlink-checker",
    related: ["backlink-checker", "domain-age-checker"],
  },
  "domain-age-checker": {
    slug: "domain-age-checker",
    path: FREE_TOOL_PATHS["domain-age-checker"],
    name: "Domain Age Checker",
    shortDescription:
      "Find when a domain was registered, when it expires, and which registrar it uses.",
    category: "technical",
    featureHref: "/features/domain-overview",
    related: ["backlink-checker", "website-traffic-checker"],
  },
  "serp-simulator": {
    slug: "serp-simulator",
    path: FREE_TOOL_PATHS["serp-simulator"],
    name: "SERP Simulator",
    shortDescription:
      "Preview your title and description in desktop and mobile search results.",
    category: "technical",
    featureHref: "/features/site-audit",
    related: [
      "competitor-keyword-finder",
      "competitor-analysis",
      "website-traffic-checker",
    ],
  },
  "google-review-link-generator": {
    slug: "google-review-link-generator",
    path: FREE_TOOL_PATHS["google-review-link-generator"],
    name: "Google Review Link Generator",
    shortDescription:
      "Build a direct Google review link from a Place ID or Maps URL. Nothing leaves your browser.",
    category: "local",
    featureHref: "/features",
    related: ["google-cid-converter", "serp-simulator"],
  },
  "google-cid-converter": {
    slug: "google-cid-converter",
    path: FREE_TOOL_PATHS["google-cid-converter"],
    name: "Google CID Converter",
    shortDescription:
      "Turn a CID or Maps URL into shareable Maps links and see the Place ID when it is in the URL.",
    category: "local",
    featureHref: "/features",
    related: ["google-review-link-generator", "domain-age-checker"],
  },
} satisfies Record<FreeToolSlug, FreeTool>;

/** Registry order drives the hub and the footer column. */
export const freeToolList: FreeTool[] = Object.values(freeTools);

export const freeToolsByCategory: Record<
  FreeToolCategory,
  { title: string; description: string; tools: FreeTool[] }
> = {
  research: {
    title: "Keyword & competitor research",
    description:
      "Traffic, keywords, backlinks, and competitor gaps powered by live SEO data.",
    tools: freeToolList.filter((t) => t.category === "research"),
  },
  local: {
    title: "Local SEO utilities",
    description:
      "Quick GBP links and converters for agencies — no account, no API calls.",
    tools: freeToolList.filter((t) => t.category === "local"),
  },
  technical: {
    title: "On-page & domain checks",
    description: "Snippet previews and registry lookups that stay in the browser.",
    tools: freeToolList.filter((t) => t.category === "technical"),
  },
};
