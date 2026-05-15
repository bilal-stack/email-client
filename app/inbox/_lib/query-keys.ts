export const queryKeys = {
  inbox: (accountId: string | null) => ["inbox", accountId] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
