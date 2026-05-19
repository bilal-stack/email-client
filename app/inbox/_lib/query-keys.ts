export type InboxFolderKey =
  | "inbox"
  | "sent"
  | "archived"
  | "spam"
  | "trash"
  | "all";

export const queryKeys = {
  /**
   * Inbox list key. Folder is part of the tuple so switching between
   * Inbox / Sent / Archived / Spam / Trash gives each view its own cache
   * slot — clicking back and forth doesn't refetch from the network.
   *
   * IMPORTANT: keep `"inbox"` as the leading segment. Other components
   * (notably `thread-list-row.tsx`'s `invalidateInbox`) invalidate by
   * predicate keyed on the first segment.
   */
  inbox: (
    accountId: string | null,
    sort: "priority" | "time" = "priority",
    folder: InboxFolderKey = "inbox",
  ) => ["inbox", folder, accountId, sort] as const,
  drafts: (accountId: string | null) => ["inbox", "drafts", accountId] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
