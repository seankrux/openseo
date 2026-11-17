# OpenSEO competitive intel & improvement plan (2026-10-26)

Scope: how to improve OpenSEO vs free SEO utilities (especially PlePer) and adjacent free-tool suites (Ahrefs, Semrush). CityThrive fork context (fleet, 1.6k sites, self-host on tokyo).

## 1. Positioning snapshot

| Player | Wedge | Monetization | Agent / API |
|--------|--------|--------------|-------------|
| **OpenSEO** | MCP + skills, BYO DataForSEO, self-host, modern app | Hosted $10/mo or own API spend | Strong (60+ MCP tools) |
| **PlePer** | Local SEO utility belt (~20 tools) | ~$10–25/mo tools + Scrape API ($0.005/credit) | Chrome ext, scrape API, no agent story |
| **Ahrefs / Semrush free** | Traffic/keyword/backlink teasers | Upsell to $100+/mo suites | Weak / gated |

OpenSEO marketing free tools today (10): the eight national/technical tools above plus **Google review link generator** and **Google CID converter** (local cluster P1, category A — client-side only). Registry: `web/src/lib/free-tools/tool-pages.ts`. Paid DataForSEO tools use Turnstile + daily budgets (`spend.ts`); local utilities have `null` spend.

PlePer tools today (20 `sdo=` routes, from homepage crawl): duplicate GBP finder, local rank tracker, GMB/Apple category lists + helper, CID converter, review/Q&A link generators, reviewer analyze, Knowledge Graph search, Wikipedia nearby, bookmarklets, **GBP scrape suite** (listing, reviews, images, posts, products, Q&A, services, menu).

## 2. Gap analysis (where PlePer wins)

**Operator utilities (low API cost, high bookmark value)**

- CID / place_id ↔ Maps link converter
- Google review & Q&A **link generators** (not analytics)
- GBP **category picker** (full list + helper)
- Duplicate listing search
- Static/reference datasets (categories 2026, Apple Maps categories)

**Scrape-first workflows**

- One-click export of GBP fields PlePer scrapes (often same need as DataForSEO Business Data, but simpler UX)

**OpenSEO already covers in product/MCP (PlePer does not)**

- Keyword research, rank tracking, site audit, GSC/GA4, AI visibility, reports, fleet table/dashboard (CityThrive), domain health, project health MCP

**OpenSEO gap in *distribution***

- PlePer tools are SEO’d individually and shared in local SEO communities; OpenSEO free tools are generic national SEO, not local-operator landing pages.

## 3. Reverse-engineering PlePer (method)

Use shipped-artifact evidence, not guesswork.

### Phase A — Catalog (1 session)

For each `index.php?do=tools&sdo=<name>`:

| Field | How |
|-------|-----|
| Inputs | Form fields from HTML |
| Output | Table/CSV/download |
| Auth | Guest vs login |
| Paid gate | Prices page + trial copy |
| Backend class | Scrape API credit vs included in plan |

Deliverable: spreadsheet `ops/pleper-tool-matrix.csv`.

### Phase B — Runtime trace (2–3 representative tools)

Pick: `cid_converter`, `dupe_search`, `scrape_google_listing_reviews`.

1. Browser DevTools → Network (or Playwright trace on headless).
2. Record endpoints, query params, rate limits, error shapes.
3. Note if results are **live scrape** vs **cached static** (categories).

### Phase C — Rebuild spec

For each tool, classify:

- **A** — Pure string/format transform (no external API) → ship as free tool, zero marginal cost.
- **B** — DataForSEO Business Data / Local SERP already in MCP → thin UI wrapper + optional free-tool route.
- **C** — Scraping Google directly → avoid; use DataForSEO or document ToS risk.
- **D** — Not strategic → skip.

### Phase D — Legal/product

- PlePer scrape tools compete with their Scrape API; OpenSEO should prefer **DataForSEO** paths already in `local-seo-tools.ts`.
- Marketing: “free local SEO tools” hub separate from national tools.

## 4. Recommended OpenSEO improvements (prioritized)

### P0 — Intel & metrics (2 weeks)

1. Finish PlePer matrix + trace 3 tools; add Ahrefs/Semrush free-tool URL list for keyword overlap.
2. Instrument OpenSEO free tools: conversion to signup, which tool → which paid feature (`analytics.ts`).
3. Search Console: which queries already hit `/keyword-generator` etc.; content gap vs PlePer tool names.

### P1 — Local free-tool cluster (high leverage vs PlePer)

Ship **4 utilities** on marketing site (category A/B), link to local MCP skills:

| Tool | Build path |
|------|------------|
| CID / place_id converter | A — client-side + validation |
| Google review link generator | A — URL templates from place_id |
| GBP category helper | B — cache `fetchBusinessListingsCategories` subset; search UI |
| Local rank check (single keyword) | B — one DataForSEO local SERP call; strict budget in `spend.ts` |

Reuse patterns: `free-tool-paths.js`, `server.ts`, Playwright `playwright.free-tools.config.ts`.

### P2 — Product bridge (CityThrive fleet)

- From **Site table**, row actions: “Review link”, “CID”, “Open in Maps” (fleet already has domain/projectId).
- Surface **duplicate GBP** as filter when you have listing data (or partner with `search_local_businesses` MCP in batch).

### P3 — Competitive content & SEO

- `/free-tools/local-seo` hub page; one landing page per tool (PlePer ranks per-tool).
- Compare pages: “OpenSEO vs PlePer for agencies” (honest: agents + fleet vs scrape utilities).

### P4 — Agent layer (moat)

- New skill: `local-seo-operator` — chains existing MCP (`search_local_businesses`, `get_local_serp_results`, `get_business_profile`) for workflows PlePer does manually.
- Expose **read-only** free endpoints that mirror top PlePer utilities but upsell “save to project + track”.

## 5. What not to build

- Full PlePer scrape menu clone (12 scrape variants) — high maintenance, ToS risk, duplicates DataForSEO.
- More national keyword free tools — crowded with Ahrefs/Semrush; low differentiation.
- Subscription local rank tracker in free tier — PlePer already owns “cheap tracker”; OpenSEO wins on **GSC-native rank tracking** in app.

## 6. Success metrics

| Metric | Target |
|--------|--------|
| Free tool → app signup | +20% from local cluster |
| Organic landing sessions | 10 indexed local tool pages in 90 days |
| Fleet operator time | −30% clicks to complete “review link + category check” per site |
| API spend per free local tool | &lt; $0.02/run at fixed caps |

## 7. Next actions (concrete)

1. ~~Phase A catalog~~ — `node ops/scripts/pleper-catalog.mjs` → `ops/pleper-tool-matrix.csv` (20 tools).
2. Playwright network capture on `cid_converter` + `dupe_search` → save HAR under `ops/pleper-traces/`.
3. PR branch `seanGPT/fleet-ux-cdd9`: local free tools **2/4**; fleet **Local** row menu on `/overview`; next: GBP category helper + local rank teaser.
4. ~~Skills~~ — `local-seo` links to openseo.so tools. Execution checklist: `ops/local-competitive-execution-plan.md`.

---

*Sources: PlePer homepage/prices fetch 2026-10-26; OpenSEO repo `web/src/lib/free-tools/*`, `src/server/mcp/tools/local-seo-tools.ts`; live stack on tokyo `ux-fleet-20261025`.*
