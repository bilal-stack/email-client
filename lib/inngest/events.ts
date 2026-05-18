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

export type AppInngestEvent = InboxMessageCreatedEvent;
