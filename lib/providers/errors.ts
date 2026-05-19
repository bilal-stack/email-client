// Canonical provider error taxonomy. Adapters map provider-specific errors
// (Gmail 401, Graph 429, IMAP NO/BAD, etc.) onto these types so the rest of
// the app can branch on a small, stable set.

export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends ProviderError {
  /**
   * When `true`, the underlying failure is transient (e.g. the OAuth token
   * endpoint timed out / 5xx'd) and the user should RETRY rather than be
   * pushed to a reconnect flow. When `false` (the default and the safe
   * fallback), the failure is treated as "your saved refresh token is no
   * longer valid" — the existing reconnect UX.
   *
   * Stays a runtime flag rather than a separate subclass so callers that
   * already do `instanceof AuthError` keep working; the canonicalizer
   * checks this flag to pick the message.
   */
  readonly transient: boolean;
  constructor(
    message: string,
    options?: { cause?: unknown; transient?: boolean },
  ) {
    super(message, options);
    this.transient = options?.transient === true;
  }
}
export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
export class NotFoundError extends ProviderError {}
export class TransientError extends ProviderError {}
export class UnknownProviderError extends ProviderError {}
