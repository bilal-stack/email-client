"use client";

import { createId } from "@paralleldrive/cuid2";
import { type IDBPDatabase, openDB } from "idb";

/**
 * Shape of a queued offline draft. Mirrors the `upsertDraft` Server
 * Action's input plus `id`, `queuedAt`, and `attemptCount` for retry
 * accounting on the replay path.
 */
export interface OfflineDraft {
  id: string;
  accountId: string;
  threadId: string | null;
  mode: "new" | "reply" | "reply-all" | "forward";
  to: Array<{ name?: string; email: string }>;
  cc: Array<{ name?: string; email: string }>;
  bcc: Array<{ name?: string; email: string }>;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string[];
  references?: string[];
  queuedAt: number;
  attemptCount: number;
}

const DB_NAME = "email-client-offline";
const STORE = "drafts";
const VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB only available in the browser"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

/** Internal: reset the cached connection. Exposed for tests that swap the
 * underlying IndexedDB shim between cases. */
export function _resetForTests(): void {
  dbPromise = null;
}

/**
 * Insert or replace a queued draft. Generates an `id` (cuid2) when absent.
 * Returns the id so the composer can keep updating the same row across
 * autosaves. Defensive: any IDB failure (Safari prerender, quota, etc.) is
 * logged and rethrown so the caller can fall through to a noop.
 */
export async function queueDraft(
  input: Omit<OfflineDraft, "id" | "queuedAt" | "attemptCount"> & { id?: string },
): Promise<string> {
  try {
    const db = await getDb();
    const id = input.id ?? createId();
    const draft: OfflineDraft = {
      accountId: input.accountId,
      threadId: input.threadId,
      mode: input.mode,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      inReplyTo: input.inReplyTo,
      references: input.references,
      id,
      queuedAt: Date.now(),
      attemptCount: 0,
    };
    await db.put(STORE, draft);
    return id;
  } catch (e) {
    console.warn("offline.queueDraft failed", { name: (e as Error)?.name });
    throw e;
  }
}

/** Return every queued draft in oldest-first order. Safe against IDB
 * failure — returns `[]` so the replay path can no-op cleanly. */
export async function listQueued(): Promise<OfflineDraft[]> {
  try {
    const db = await getDb();
    const all = await db.getAll(STORE);
    return (all as OfflineDraft[]).sort((a, b) => a.queuedAt - b.queuedAt);
  } catch (e) {
    console.warn("offline.listQueued failed", { name: (e as Error)?.name });
    return [];
  }
}

/** Idempotent removal — succeeds even when `id` doesn't exist. */
export async function removeQueued(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE, id);
  } catch (e) {
    console.warn("offline.removeQueued failed", { name: (e as Error)?.name });
  }
}

/** Wipe the entire queue. Called from the sign-out handler so a second
 * user on the same device doesn't inherit drafts. */
export async function clearQueued(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE);
  } catch (e) {
    console.warn("offline.clearQueued failed", { name: (e as Error)?.name });
  }
}

/** Bump a draft's retry counter after a failed replay attempt. Best-effort
 * — a failed bump silently no-ops, which is fine because the entry still
 * sits in the queue and will be retried on the next `online` event. */
export async function bumpAttempt(id: string): Promise<void> {
  try {
    const db = await getDb();
    const row = (await db.get(STORE, id)) as OfflineDraft | undefined;
    if (!row) return;
    row.attemptCount += 1;
    await db.put(STORE, row);
  } catch {
    /* best-effort */
  }
}
