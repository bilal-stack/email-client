// Canonical Inngest event names + payloads.
//
// The `inngest` client in `./client.ts` is untyped (no `EventSchemas`) so
// these types are documentation + the source-of-truth shape that producers
// and consumers both build against. Producers pass `name` + `data` matching
// `InboxMessageCreatedEvent` to `inngest.send`; the consumer
// (`functions/prioritize-message.ts`) reads `event.data` with an explicit
// cast to `InboxMessageCreatedEvent["data"]`.

export const INBOX_MESSAGE_CREATED = "inbox/message.created" as const;

export interface InboxMessageCreatedEvent {
  name: typeof INBOX_MESSAGE_CREATED;
  data: {
    messageId: string;
    threadId: string;
    accountId: string;
    userId: string;
  };
}

/**
 * Emitted by the `sendDraft` Server Action after it has persisted a SendTask
 * row + attachments. The `process-send-task` Inngest function picks the
 * event up, loads the task, and performs the actual provider call. The
 * event payload deliberately carries only the task id — the row holds the
 * full draft + attachments, including bytes that would exceed Inngest's
 * per-event size cap if inlined.
 */
export const INBOX_SEND_TASK_QUEUED = "inbox/send-task.queued" as const;

export interface InboxSendTaskQueuedEvent {
  name: typeof INBOX_SEND_TASK_QUEUED;
  data: {
    taskId: string;
    userId: string;
    accountId: string;
  };
}

export type AppInngestEvent = InboxMessageCreatedEvent | InboxSendTaskQueuedEvent;
