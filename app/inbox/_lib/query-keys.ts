export const queryKeys = {
  inbox: (accountId: string | null, sort: "priority" | "time" = "priority") =>
    ["inbox", accountId, sort] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
