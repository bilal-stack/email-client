// @vitest-environment node
// SSRF guard tests for `assertHostAllowed`. NODE_ENV is read at module load
// time, so each "production" / "development" describe block uses
// `vi.resetModules()` + a fresh dynamic import after stubbing the env var.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:dns at the module level so the prod hostname path is deterministic.
// imap-host-guard imports `{ promises as dns } from "node:dns"`, so the mock
// must shape the module so `mod.promises.lookup` resolves to our vi.fn.
const dnsLookupMock = vi.fn();
vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: { ...actual.promises, lookup: dnsLookupMock },
    default: { ...actual, promises: { ...actual.promises, lookup: dnsLookupMock } },
  };
});

async function importGuardWithEnv(env: "production" | "development" | "test") {
  vi.stubEnv("NODE_ENV", env);
  vi.resetModules();
  return await import("./imap-host-guard");
}

afterEach(() => {
  vi.unstubAllEnvs();
  dnsLookupMock.mockReset();
});

describe("assertHostAllowed in production", () => {
  beforeEach(() => {
    // Ensure mocks are reset between cases. importGuardWithEnv handles module reset.
    dnsLookupMock.mockReset();
  });

  it.each([
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
  ])("rejects RFC1918 / loopback / link-local IPv4 literal: %s", async (ip) => {
    const { assertHostAllowed } = await importGuardWithEnv("production");
    await expect(assertHostAllowed(ip, 993)).rejects.toThrow("IMAP host not allowed");
  });

  it.each(["::1", "fc00::1", "fe80::1"])(
    "rejects IPv6 private / loopback / link-local literal: %s",
    async (ip) => {
      const { assertHostAllowed } = await importGuardWithEnv("production");
      await expect(assertHostAllowed(ip, 993)).rejects.toThrow("IMAP host not allowed");
    },
  );

  it("rejects a hostname that DNS-resolves to a private IP (AWS metadata SSRF)", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const { assertHostAllowed } = await importGuardWithEnv("production");
    await expect(assertHostAllowed("attacker.example.com", 993)).rejects.toThrow(
      "IMAP host not allowed",
    );
    expect(dnsLookupMock).toHaveBeenCalledWith("attacker.example.com", { all: true });
  });

  it("accepts a hostname that resolves to a public IP", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }]);
    const { assertHostAllowed } = await importGuardWithEnv("production");
    await expect(assertHostAllowed("imap.example.com", 993)).resolves.toBeUndefined();
  });

  it("rejects localhost in production (no dev-loopback bypass)", async () => {
    // localhost in prod falls through to the DNS-resolution branch — set the mock
    // to whatever an authoritative resolver would return (usually 127.0.0.1).
    dnsLookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const { assertHostAllowed } = await importGuardWithEnv("production");
    await expect(assertHostAllowed("localhost", 993)).rejects.toThrow("IMAP host not allowed");
  });
});

describe("assertHostAllowed in development", () => {
  it.each(["localhost", "127.0.0.1", "::1"])(
    "allows %s for local development",
    async (host) => {
      const { assertHostAllowed } = await importGuardWithEnv("development");
      await expect(assertHostAllowed(host, 993)).resolves.toBeUndefined();
    },
  );
});

describe("assertHostAllowed port validation", () => {
  it.each([0, -1, 65536])("rejects out-of-range port %i", async (port) => {
    const { assertHostAllowed } = await importGuardWithEnv("production");
    await expect(assertHostAllowed("1.2.3.4", port)).rejects.toThrow("IMAP host not allowed");
  });
});
