import type { DraftMode } from "@/lib/compose/draft-queries";
import type { CanonicalAddress } from "@/lib/providers/types";

export interface DraftDTO {
  id: string;
  accountId: string;
  threadId: string | null;
  mode: DraftMode;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  bcc: CanonicalAddress[];
  subject: string;
  bodyHtml: string;
  inReplyTo: string[];
  references: string[];
  updatedAt: Date;
}
