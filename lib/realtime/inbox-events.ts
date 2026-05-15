import { EventEmitter } from "node:events";

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
  bus.emit(channel(userId), event);
}

export function subscribeInboxSyncEvents(
  userId: string,
  listener: (e: SyncEvent) => void,
): () => void {
  const ch = channel(userId);
  bus.on(ch, listener);
  return () => {
    bus.off(ch, listener);
  };
}
