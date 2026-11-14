import {
  GoogleGrantError,
  GoogleTokenEndpointError,
} from "@/server/features/google/googleOAuthErrors";

import { Ga4TokenError } from "./ga4Errors";

export const GSC_API_DISABLED_MESSAGE =
  "The Search Console API isn't enabled in the Google Cloud project that owns this deployment's OAuth client. Enable it, then retry.";

export class GscApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GscApiError";
  }

  /** Google's 403 when the API isn't enabled in the OAuth client's Cloud
   *  project: a self-host setup fault, not a dead grant. */
  get apiDisabled(): boolean {
    return this.status === 403 && !!this.body?.includes("SERVICE_DISABLED");
  }
}

export class GscTokenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GscTokenError";
  }
}

export class GscNotConnectedError extends Error {
  constructor(public readonly projectId: string) {
    super("Search Console is not connected for this project");
    this.name = "GscNotConnectedError";
  }
}

export type GscFailureKind =
  | "auth"
  | "permission"
  | "quota"
  | "transient"
  | "setup"
  | "other";

/** Also accepts legacy cache strings, which predate typed provider failures. */
export function classifyGscError(error: unknown): GscFailureKind {
  if (error instanceof GoogleGrantError) return "auth";
  if (error instanceof GoogleTokenEndpointError) {
    if (error.status === 429) return "quota";
    return error.status >= 500 ? "transient" : "setup";
  }
  if (
    (error instanceof GscTokenError || error instanceof Ga4TokenError) &&
    error.cause
  )
    return classifyGscError(error.cause);
  if (error instanceof GscApiError) {
    if (error.apiDisabled) return "setup";
    if (
      error.status === 429 ||
      /quota|rate.?limit|resource_exhausted/i.test(error.body ?? "")
    )
      return "quota";
    if (error.status === 401) return "auth";
    if (error.status === 403) return "permission";
    if ([500, 502, 503, 504].includes(error.status)) return "transient";
  }
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/SERVICE_DISABLED|isn.t enabled|OAuth.*(configur|client)/i.test(message))
    return "setup";
  if (/quota|rate.?limit|\b429\b/i.test(message)) return "quota";
  if (
    /timeout|timed out|abort|network|fetch failed|failed to fetch|ECONNRESET|EAI_AGAIN|ECONNREFUSED|temporar|upstream|API error \(50[0234]\)/i.test(
      message,
    )
  )
    return "transient";
  if (/denied access|permission|\b403\b/i.test(message)) return "permission";
  if (
    /revoked|invalid_grant|expired|no .* grant|authorization failed|could not mint .*token|grant is missing|cannot be refreshed/i.test(
      message,
    )
  )
    return "auth";
  return "other";
}
