export interface ThreadMessageDTO {
  id: string;
  fromName: string;
  fromEmail: string;
  toLine: string;
  receivedAt: Date;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: Array<{ id: string; filename: string; size: number; mimeType: string }>;
}

export interface ThreadDTO {
  id: string;
  subject: string;
  accountId: string;
  accountEmail: string;
  /// Thread-level labels (union across all messages, as written by the
  /// sync worker). The thread-actions header reads these to decide which
  /// buttons to show — e.g. "Not spam" appears only when SPAM is present.
  labels: string[];
}
