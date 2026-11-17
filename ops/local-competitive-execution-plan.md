# Local competitive execution plan (pstack-backed)

**Config:** `.cursor/rules/pstack-models.mdc` (budget large / xhigh, Grok fast + Opus judgment).

## Done

| Item | Artifact |
|------|----------|
| P1 local free tools (2/4) | `web/` review link + CID converter, categorized `/tools` hub |
| Intel doc | `ops/competitive-intel-openseo-20261026.md` |
| Skills | `local-seo` → openseo.so tool links |
| Phase A catalog | `node ops/scripts/pleper-catalog.mjs` → `ops/pleper-tool-matrix.csv` |
| P2 fleet bridge | Site table **Local** menu on `/overview` |

## Next (ordered)

1. **Deploy marketing** — `cd web && VITE_REQUIRE_TURNSTILE=1 pnpm run deploy:prod` (Cloudflare creds).
2. **GBP category helper** — ship static or cached DFS list + search UI (`google-business-category-helper`).
3. **Local rank teaser** — one capped DataForSEO local SERP in `spend.ts` + Turnstile.
4. **Phase B traces** — HAR under `ops/pleper-traces/` for `cid_converter`, `dupe_search`.
5. **Rebuild tokyo app image** after fleet UX + overview local column land in deploy branch.

## pstack usage

- **feature / swarm workers:** implement routes, fleet column, scripts in parallel.
- **judgment and prose:** FAQ copy, intel doc, skill wording.
- **hardest tasks:** category cache design + rank teaser budgets.
