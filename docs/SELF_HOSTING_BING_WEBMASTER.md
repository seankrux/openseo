# Bing Webmaster: installed workspace connector

## What it does

In project **Settings → Integrations**, choose **Connect Bing**, then select a verified Bing site matching the project's hostname. The connection stays saved; no organization ID or API-key field appears in the app. The card uses the Bing connector installed for this workspace; it does **not** start a Microsoft OAuth consent flow. Missing configuration is setup-required, not connected.

An explicit refresh reads only Bing's JSON `GetUserSites`, `GetRankAndTrafficStats` and `GetCrawlStats` endpoints as appropriate to discovery/binding/refresh. It stores a private project/binding-scoped snapshot. Health reports read saved snapshots without contacting Bing. No background schedule, URL submission, site creation, IndexNow call or indexing guarantee is added.

## One-time operator setup

1. Use only a trusted self-hosted workspace. The installed-key connector fails closed for hosted/unknown authentication modes. `local_noauth` must remain behind a private network or external authentication; the mode itself authenticates nobody. Cloudflare Access must retain its existing verified issuer/audience policy.
2. Obtain a Bing Webmaster API key for the authorized account. Inject it server-side as `BING_WEBMASTER_API_KEY` through the deployment's approved secret manager. Do not paste it into chat, source, browser settings, reports or logs. The key belongs to a Bing user and can cover multiple sites; **it is not a read-only credential**.
3. Set `BING_WEBMASTER_ENABLED=true` only after authorizing the connector. Leave it unset/false to disable network access. Neither variable is set by application code or the local test implementation.
4. Apply the additive SQLite/Postgres migrations using the deployment's established backup/migration process, build/redeploy the existing service, then refresh its existing URL. Do not replace its hostname, port, authentication or persistent volumes.
5. Open the project's Integrations tab and connect a matching verified site. The server revalidates the selection; changing a project hostname does not establish Bing ownership. Use the explicit refresh tool when you want new saved data.

No user-managed organization-ID setting is needed. Runtime authentication determines the one canonical self-hosted workspace. All users admitted to that workspace must be authorized to use the installed key's sites. This follows OpenSEO's existing shared-owner/self-hosted trust model; it is not per-user account delegation. Do not reuse this design to share a global key among hosted tenants. Hosted support requires a separate workspace-owned OAuth grant without an installed-key fallback.

## Data and failure semantics

- Keep the binding and snapshot private; reconnect/disconnect invalidates the active binding rather than exposing old objects by a guessed path.
- Disabling provider access or losing the key does not erase an authorized saved snapshot. Reports can still show its original fetch time; a failed refresh must not overwrite it with zeroes. Disconnect to remove the project's active access to that snapshot.
- Bing returns daily provider windows, not an arbitrary requested GSC comparison period. Some dates include a source offset; absent offsets do not establish the provider's reporting timezone.
- Performance combines Bing surfaces; do not compare it directly to Google Search Console. Crawl/index counts are observations, not proof that an individual URL is currently indexed or a reason to sum daily index totals.
- Reports display at most 31 newest performance/crawl rows with an explicit omitted-scope notice, not a complete-period total. Missing/error evidence is unknown, never healthy or zero.
- The connector has fixed GET-only routes, redirect rejection, timeouts and response/row limits. These restrictions narrow what the application can do; they do not downgrade the underlying key's permissions.

## OAuth and IndexNow are separate

A real **sign in to Bing** flow requires registering a Bing OAuth client with an exact callback URI, read-only consent, encrypted workspace grants, one-use user/workspace-bound CSRF state and verified refresh behavior. Microsoft documents `Webmaster.read`, but its examples disagree on scope casing and refresh parameters. This installed connector does not pretend those compatibility checks have passed.

IndexNow is change notification, not Webmaster reporting or Google indexing. It remains off; existing submission producers/timers are not modified by this integration. CrUX remains queued separately.

## First live smoke check

Local tests do not prove the account is connected. After separate deployment/credential authorization, verify setup status, a verified matching site, saved binding and explicit read refresh. The initial discovery/performance/crawl smoke check should stay within the separately approved read budget; connecting/revalidating a picker can add discovery reads. Never claim an account/site is connected without a successful authorized readback.

## Local connector checks

- `pnpm test` and `pnpm test:ci` run the Node-based tests, including static card rendering. They do not require Chrome.
- `pnpm test:components` separately runs the interactive Bing card checks in installed Chrome. Set `PLAYWRIGHT_CHANNEL` to select another separately provisioned Chromium-compatible channel. The command does not install a browser or silently skip missing-browser failures.
- Component checks bundle the real card in memory, replace only the server-function boundary and block HTTP/WebSocket requests and service workers. They start no app server and use no Bing credentials. They are excluded from the normal app E2E suite and do not replace the authorized live smoke check above.

## Primary references

- [Bing: getting access](https://learn.microsoft.com/en-us/bingwebmaster/getting-access)
- [Bing API protocols](https://learn.microsoft.com/en-us/bingwebmaster/api-protocols)
- [Bing OAuth](https://learn.microsoft.com/en-us/bingwebmaster/oauth2)
- [Bing API method reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet)
- [IndexNow documentation](https://www.indexnow.org/documentation)
