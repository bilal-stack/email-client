// Aggregator of all Inngest functions registered on `/api/inngest`.
// Each spec adds its functions here so the serve handler stays a one-liner.

import { gmailSyncDelta } from "./gmail-sync";
import { graphSyncDelta } from "./graph-sync";
import { imapSyncPoll } from "./imap-sync";
import { prioritizeMessageFn } from "./prioritize-message";

export const inngestFunctions = [
  gmailSyncDelta,
  graphSyncDelta,
  imapSyncPoll,
  prioritizeMessageFn,
];
