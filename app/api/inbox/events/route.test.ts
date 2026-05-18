// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";
import { GET } from "./route";

const authMock = vi.mocked(auth);

beforeEach(() => {
  authMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeRequest(): { request: Request; abort: () => void } {
  const controller = new AbortController();
  const request = new Request("http://localhost/api/inbox/events", {
    signal: controller.signal,
  });
  return { request, abort: () => controller.abort() };
}

async function readNextNonHeartbeatChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream closed before a data chunk arrived");
    const text = decoder.decode(value);
    // Heartbeats start with ":" — comments per the SSE spec.
    if (text.startsWith(":")) continue;
    return text;
  }
  throw new Error("too many heartbeats");
}

describe("GET /api/inbox/events", () => {
  it("returns 401 when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const { request } = makeRequest();
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("streams an emitted SyncEvent as a `data:` chunk to a subscribed user", async () => {
    const userId = `userSSE-${Date.now()}`;
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { request } = makeRequest();
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    if (!response.body) throw new Error("response.body should be present for SSE stream");
    const reader = response.body.getReader();
    const evt = { accountId: "acc-1", threadIds: ["t-1"], at: Date.now() };
    // Defer the emit so the route handler has time to subscribe and the
    // initial ": connected" heartbeat is queued first.
    setTimeout(() => emitInboxSyncEvent(userId, evt), 5);

    const chunk = await readNextNonHeartbeatChunk(reader);
    expect(chunk).toContain("data: ");
    const payload = JSON.parse(chunk.slice("data: ".length).trim());
    // The bus wraps the producer's SyncEvent with `type: "inbox-sync"` for the
    // discriminated-union SSE payload — the route forwards verbatim.
    expect(payload).toEqual({ type: "inbox-sync", ...evt });

    await reader.cancel();
  });

  it("removes its bus listener and closes the stream when the request is aborted", async () => {
    const userId = `userSSE-${Date.now()}-abort`;
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { request, abort } = makeRequest();
    const response = await GET(request);
    if (!response.body) throw new Error("response.body should be present for SSE stream");
    const reader = response.body.getReader();
    // Drain the initial ": connected" heartbeat so the start callback has fully run.
    await reader.read();

    const busModule = await import("@/lib/realtime/inbox-events");
    const busKey = Symbol.for("email-client.inbox-events.emitter");
    // The bus is stashed on globalThis under a Symbol key — fish it out via a
    // typed cast that mirrors how the module itself reaches it.
    const g = globalThis as unknown as { [k: symbol]: import("node:events").EventEmitter };
    const bus = g[busKey];
    if (!bus) throw new Error("inbox bus not initialized after route subscribe");
    const channel = `inbox:${userId}`;
    expect(bus.listenerCount(channel)).toBe(1);

    abort();
    // Allow the abort handler to fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(bus.listenerCount(channel)).toBe(0);

    // Emitting after abort must be a no-op for this stream.
    busModule.emitInboxSyncEvent(userId, { accountId: "x", threadIds: [], at: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.listenerCount(channel)).toBe(0);
  });

  it("emits a heartbeat `: ping` chunk every 25s", async () => {
    // Install fake timers BEFORE GET() so the setInterval registered in the
    // stream's start() callback is also under fake control.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout"] });
    const userId = `userSSE-${Date.now()}-hb`;
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { request } = makeRequest();
    const response = await GET(request);
    if (!response.body) throw new Error("response.body should be present for SSE stream");
    const reader = response.body.getReader();

    // Drain the initial ": connected" comment line.
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(": connected");

    vi.advanceTimersByTime(26_000);

    const next = await reader.read();
    expect(decoder.decode(next.value)).toContain(": ping");

    await reader.cancel();
  });
});
