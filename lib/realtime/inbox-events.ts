import { EventEmitter } from "node:events";

// Discriminated-union SSE event payloads. Producers wrap their data in the
// matching `type` tag; the SSE route at `/api/inbox/events` JSON-encodes the
// whole object straight to the client. The listener
// (`app/inbox/_components/inbox-events-listener.tsx`) switches on `type`.
//
// `SyncEvent` stays exported as a structural alias of the existing
// inbox-sync payload so call-sites that previously named the type keep
// working.
export type InboxSseEvent =
  | { type: "inbox-sync"; accountId: string; threadIds: string[]; at: number }
  | {
      type: "priority-updated";
      threadId: string;
      scoredMessageIds: string[];
      at: number;
    };

export interface SyncEvent {
  accountId: string;
  threadIds: string[];
  at: number;
}

const globalKey = Symbol.for("email-client.inbox-events.emitter");
type GlobalWithBus = typeof globalThis & { [globalKey]?: EventEmitter };
const g = globalThis as GlobalWithBus;
if (!g[globalKey]) {
  g[globalKey] = new EventEmitter().setMaxListeners(1000);
}
const bus: EventEmitter = g[globalKey];

function channel(userId: string) {
  return `inbox:${userId}`;
}

export function emitInboxSyncEvent(userId: string, event: SyncEvent): void {
  const payload: InboxSseEvent = { type: "inbox-sync", ...event };
  bus.emit(channel(userId), payload);
}

export function emitPriorityUpdatedEvent(
  userId: string,
  event: { threadId: string; scoredMessageIds: string[]; at: number },
): void {
  const payload: InboxSseEvent = { type: "priority-updated", ...event };
  bus.emit(channel(userId), payload);
}

export function subscribeInboxSyncEvents(
  userId: string,
  listener: (e: InboxSseEvent) => void,
): () => void {
  const ch = channel(userId);
  bus.on(ch, listener);
  return () => {
    bus.off(ch, listener);
  };
}
