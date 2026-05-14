// Canonical provider error taxonomy. Adapters map provider-specific errors
// (Gmail 401, Graph 429, IMAP NO/BAD, etc.) onto these types so the rest of
// the app can branch on a small, stable set.

export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends ProviderError {}
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
