/** Confirmed absent, expired or rejected user grant; reconnect can repair it. */
export class GoogleGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleGrantError";
  }
}

/** OAuth endpoint/configuration failure, distinct from a rejected user grant. */
export class GoogleTokenEndpointError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 429
        ? "Google token refresh rate limit reached."
        : status >= 500
          ? "Google token refresh is temporarily unavailable."
          : "Google OAuth token endpoint rejected this deployment's configuration.",
    );
    this.name = "GoogleTokenEndpointError";
  }
}
