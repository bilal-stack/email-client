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
}
