import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import type {
  OrganicSerpEntry,
  OrganicSerpQuery,
  SerpProvider,
} from "@/server/lib/serp-provider";

// Semrush Analytics API v3, `phrase_organic` report: the domains and URLs that
// rank for one phrase in one regional database. It answers from Semrush's own
// index, not a live crawl, so positions lag Google by up to the database's
// update cycle. Databases are country-level only: there is no city, local-pack
// or Maps data, and the SERP language is fixed by the database.
// Billing: 10 API units per returned line.
// https://developer.semrush.com/api/v3/analytics/keyword-reports/
const SEMRUSH_API_URL = "https://api.semrush.com/";
const REQUEST_TIMEOUT_MS = 30_000;

// Requested in this order so the URL, the only column that can hold a `;`,
// is last and can be re-joined.
const EXPORT_COLUMNS = "Po,Dn,Ur";
const EXPECTED_HEADER = ["Position", "Domain", "Url"];

// Regional databases `phrase_organic` accepts, keyed by Semrush's region code
// (ISO 3166-1 alpha-2 except `uk`). Mobile data exists only for MOBILE_REGIONS.
const DESKTOP_REGIONS = new Set(
  "us uk ca ru de fr es it br au ar be ch dk fi hk ie il mx nl no pl se sg tr jp in hu af al dz ao am at az bh bd by bz bo ba bw bn bg cv kh cm cl co cr hr cy cz cd do ec eg sv ee et ge gh gr gt gy ht hn is id jm jo kz kw lv lb lt lu mg my mt mu md mn me ma mz na np nz ni ng om py pe ph pt ro sa sn rs sk si za kr lk th bs tt tn ua ae uy ve vn zm zw ly pa pk tw qa".split(
    " ",
  ),
);
const MOBILE_REGIONS = new Set(
  "us uk ca de fr es it br au dk mx nl se tr in id il".split(" "),
);

/** The Semrush database for a country and device, or null when none exists. */
export function semrushDatabase(
  countryCode: string,
  device: OrganicSerpQuery["device"],
): string | null {
  const iso = countryCode.toLowerCase();
  const region = iso === "gb" ? "uk" : iso;
  if (device === "mobile") {
    return MOBILE_REGIONS.has(region) ? `mobile-${region}` : null;
  }
  return DESKTOP_REGIONS.has(region) ? region : null;
}

// Errors arrive as one plain-text line, e.g. `ERROR 132 :: API UNITS BALANCE
// IS ZERO`, sometimes with HTTP 200 and sometimes with 403.
const ERROR_LINE = /^ERROR (\d+) :: (.*)$/;
const NOTHING_FOUND = 50;
// Wrong or unknown key, API disabled, database or report not in the plan.
const ACCESS_ERRORS = new Set([120, 122, 130, 133, 135, 402]);
// Out of units or over a request limit.
const QUOTA_ERRORS = new Set([131, 132, 134, 429]);

function semrushError(code: number, line: string): AppError {
  const message = `Semrush: ${line}`;
  if (ACCESS_ERRORS.has(code)) return new AppError("FORBIDDEN", message);
  if (QUOTA_ERRORS.has(code)) return new AppError("RATE_LIMITED", message);
  return new AppError("UPSTREAM_UNAVAILABLE", message);
}

const rowSchema = z.object({
  position: z.coerce.number().int().min(1).max(100),
  domain: z.string().min(1),
  url: z.string().min(1),
});

/**
 * Parse a `phrase_organic` response (semicolon-separated CSV with a header
 * line). `ERROR 50 :: NOTHING FOUND` is a valid empty SERP; every other error
 * line becomes an AppError, and a body that does not match the requested
 * columns is rejected rather than read as "not ranking".
 */
export function parsePhraseOrganicResponse(
  httpStatus: number,
  body: string,
): OrganicSerpEntry[] {
  const text = body.trim();
  const error = ERROR_LINE.exec(text);
  if (error) {
    const code = Number(error[1]);
    if (code === NOTHING_FOUND) return [];
    throw semrushError(code, text);
  }
  if (httpStatus === 429) throw semrushError(429, `HTTP ${httpStatus}`);
  if (httpStatus !== 200) {
    throw new AppError("UPSTREAM_UNAVAILABLE", `Semrush: HTTP ${httpStatus}`);
  }

  const [header, ...lines] = text.split(/\r?\n/).filter((line) => line !== "");
  if (header !== EXPECTED_HEADER.join(";")) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Semrush: unexpected phrase_organic columns",
    );
  }
  return lines.map((line) => {
    const [position, domain, ...url] = line.split(";");
    const parsed = rowSchema.safeParse({
      position,
      domain,
      url: url.join(";"),
    });
    if (!parsed.success) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Semrush: malformed phrase_organic row",
      );
    }
    return parsed.data;
  });
}

export function createSemrushSerpProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): SerpProvider {
  return {
    id: "semrush",
    async organicSerp(query) {
      if (query.locationName) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Semrush has country-level rankings only. Remove the city from this tracker to check it.",
        );
      }
      const database = semrushDatabase(query.countryCode, query.device);
      if (!database) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Semrush has no ${query.device} database for country "${query.countryCode}".`,
        );
      }
      const params = new URLSearchParams({
        type: "phrase_organic",
        key: apiKey,
        phrase: query.keyword,
        database,
        display_limit: String(query.depth),
        export_columns: EXPORT_COLUMNS,
      });
      let response: Response;
      try {
        response = await fetchImpl(`${SEMRUSH_API_URL}?${params}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // The request URL carries the key, so never surface the raw error.
        throw new AppError("UPSTREAM_UNAVAILABLE", "Semrush: request failed");
      }
      return parsePhraseOrganicResponse(response.status, await response.text());
    },
  };
}
