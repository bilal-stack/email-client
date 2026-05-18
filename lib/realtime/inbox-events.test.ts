// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  type InboxSseEvent,
  type SyncEvent,
  emitInboxSyncEvent,
  subscribeInboxSyncEvents,
} from "./inbox-events";

function makeEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    accountId: overrides.accountId ?? "acc-1",
    threadIds: overrides.threadIds ?? ["t-1", "t-2"],
    at: overrides.at ?? Date.now(),
  };
}

// Subscribers receive the wrapped discriminated-union payload, not the bare
// `SyncEvent` the producer was given. Helper centralizes the wrap so the
// assertions stay readable.
function wrapAsSync(evt: SyncEvent): Extract<InboxSseEvent, { type: "inbox-sync" }> {
  return { type: "inbox-sync", ...evt };
}

describe("inbox-events — emit / subscribe", () => {
  it("delivers an event to a subscriber for the same user with the payload intact", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInboxSyncEvents("userA", listener);
    const evt = makeEvent({ accountId: "acc-A", threadIds: ["t-aaa", "t-bbb"] });

    emitInboxSyncEvent("userA", evt);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(wrapAsSync(evt));
    unsubscribe();
  });

  it("isolates channels per user — userA's subscriber does not see userB's events", () => {
    const aListener = vi.fn();
    const bListener = vi.fn();
    const unsubA = subscribeInboxSyncEvents("userA", aListener);
    const unsubB = subscribeInboxSyncEvents("userB", bListener);

    emitInboxSyncEvent("userB", makeEvent({ accountId: "acc-B" }));

    expect(aListener).not.toHaveBeenCalled();
    expect(bListener).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it("stops delivering events after unsubscribe()", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInboxSyncEvents("userC", listener);

    emitInboxSyncEvent("userC", makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitInboxSyncEvent("userC", makeEvent());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers an event to multiple subscribers on the same user", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const u1 = subscribeInboxSyncEvents("userD", l1);
    const u2 = subscribeInboxSyncEvents("userD", l2);

    const evt = makeEvent({ accountId: "acc-D" });
    emitInboxSyncEvent("userD", evt);

    expect(l1).toHaveBeenCalledWith(wrapAsSync(evt));
    expect(l2).toHaveBeenCalledWith(wrapAsSync(evt));
    u1();
    u2();
  });

  it("uses a singleton EventEmitter cached on globalThis (HMR safety)", async () => {
    // Re-import the module after busting the require/loader cache: vitest's
    // dynamic import handles ?cb= cache busters; the symbol-keyed globalThis
    // entry must keep both module instances pointing at the same emitter.
    const a = await import("./inbox-events");
    const b = await import(`./inbox-events?cb=${Date.now()}`);

    const listener = vi.fn();
    const unsubscribe = a.subscribeInboxSyncEvents("userHMR", listener);
    const evt = makeEvent({ accountId: "acc-HMR" });
    b.emitInboxSyncEvent("userHMR", evt);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(wrapAsSync(evt));
    unsubscribe();
  });
});
