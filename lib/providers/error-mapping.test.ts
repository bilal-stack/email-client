import { describe, expect, it } from "vitest";
import { mapError } from "./error-mapping";
import {
  AuthError,
  NotFoundError,
  type ProviderError,
  RateLimitError,
  TransientError,
  UnknownProviderError,
} from "./errors";

interface FakeGaxiosError {
  code?: number | string;
  status?: number;
  message?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: { error?: { message?: string } };
  };
}

function gaxiosLike(status: number, message: string, extras: Partial<FakeGaxiosError> = {}) {
  return {
    code: status,
    message,
    response: {
      status,
      headers: extras.response?.headers ?? {},
      data: { error: { message } },
    },
    ...extras,
  } satisfies FakeGaxiosError;
}

describe("mapError", () => {
  it("maps 401 to AuthError and surfaces a debuggable cause", () => {
    const raw = gaxiosLike(401, "Invalid Credentials");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(AuthError);
    expect(mapped.message).toBe("Invalid Credentials");
    // Cause is sanitized (no circular gaxios refs) but carries the key fields.
    expect(mapped.cause).toMatchObject({ status: 401, message: "Invalid Credentials" });
  });

  it("maps 403 with insufficientPermissions message to AuthError", () => {
    const raw = gaxiosLike(403, "Request had insufficientPermissions for this resource");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(AuthError);
  });

  it("maps 404 with a normal message to NotFoundError", () => {
    const raw = gaxiosLike(404, "Requested entity was not found.");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect(mapped).not.toBeInstanceOf(AuthError);
  });

  it("maps 404 with historyId-not-found to AuthError with the reconnect message", () => {
    const raw = gaxiosLike(404, "Requested entity was not found. historyId not found.");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(AuthError);
    expect(mapped.message).toContain("Sync history expired — reconnect required");
  });

  it("maps 429 with Retry-After: 30 to RateLimitError with retryAfterSeconds === 30", () => {
    const raw = gaxiosLike(429, "Rate limit hit", {
      response: {
        status: 429,
        headers: { "retry-after": "30" },
        data: { error: { message: "Rate limit hit" } },
      },
    });
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(RateLimitError);
    expect((mapped as RateLimitError).retryAfterSeconds).toBe(30);
  });

  it("maps 500 to TransientError", () => {
    const mapped = mapError(gaxiosLike(500, "Backend Error"));
    expect(mapped).toBeInstanceOf(TransientError);
  });

  it("maps 503 to TransientError", () => {
    const mapped = mapError(gaxiosLike(503, "Service Unavailable"));
    expect(mapped).toBeInstanceOf(TransientError);
  });

  it("maps a network error (no status) to TransientError", () => {
    const raw = new Error("ECONNRESET");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(TransientError);
    expect(mapped.cause).toMatchObject({ message: "ECONNRESET" });
  });

  it("maps an invalid_grant body string to AuthError (via 403 path)", () => {
    const raw = gaxiosLike(403, "invalid_grant: Token has been expired or revoked.");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(AuthError);
  });

  it("maps an unknown status (418) to UnknownProviderError", () => {
    const mapped = mapError(gaxiosLike(418, "I'm a teapot"));
    expect(mapped).toBeInstanceOf(UnknownProviderError);
  });

  it("returns the same ProviderError instance if passed a ProviderError (idempotent)", () => {
    const original = new AuthError("already mapped");
    const mapped = mapError(original);
    expect(mapped).toBe(original);
  });

  it("attaches a serializable .cause for every mapped variant", () => {
    const cases: Array<[FakeGaxiosError | Error, abstract new (...a: never[]) => ProviderError]> = [
      [gaxiosLike(401, "x"), AuthError],
      [gaxiosLike(404, "x"), NotFoundError],
      [gaxiosLike(429, "x"), RateLimitError],
      [gaxiosLike(500, "x"), TransientError],
      [gaxiosLike(418, "x"), UnknownProviderError],
      [new Error("network"), TransientError],
    ];
    for (const [raw, Ctor] of cases) {
      const mapped = mapError(raw);
      expect(mapped).toBeInstanceOf(Ctor);
      // Cause is sanitized (no circular gaxios refs) but JSON-serializable.
      expect(mapped.cause).not.toBe(raw);
      expect(() => JSON.stringify(mapped.cause)).not.toThrow();
    }
  });

  it("maps Graph 410 with deltaToken-related message to AuthError with reconnect text", () => {
    // Carries Graph's nested envelope shape so we ALSO regression-cover
    // `pickMessage` reading `response.data.error.message` correctly.
    const raw: FakeGaxiosError = {
      code: 410,
      message: "Gone",
      response: {
        status: 410,
        data: {
          error: {
            message:
              "The deltaToken used in the request was not found. Run a delta query without a deltaLink to get a fresh sync state.",
          },
        },
      },
    };
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(AuthError);
    expect(mapped.message).toContain("Sync delta expired — reconnect required");
  });

  it("maps Graph 410 with a non-delta message to NotFoundError", () => {
    const raw = gaxiosLike(410, "The specified object has been permanently deleted.");
    const mapped = mapError(raw);
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect(mapped).not.toBeInstanceOf(AuthError);
  });

  it("strips circular gaxios refs so the cause is JSON-serializable", () => {
    // Build a circular structure that mirrors how googleapis surfaces errors
    // (config <-> response <-> request). Verifies the Inngest step-output
    // serialization path (which JSON.stringify's thrown errors) won't choke.
    const circular: Record<string, unknown> = { name: "GaxiosError", message: "boom", code: 500 };
    const response: Record<string, unknown> = { status: 500, data: { error: { message: "boom" } } };
    circular.response = response;
    response.config = circular;
    response.request = circular;
    (circular as { config?: unknown }).config = circular;

    const mapped = mapError(circular);
    expect(mapped).toBeInstanceOf(TransientError);
    expect(() => JSON.stringify(mapped.cause)).not.toThrow();
  });
});
