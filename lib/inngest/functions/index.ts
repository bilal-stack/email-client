// Aggregator of all Inngest functions registered on `/api/inngest`.
// Each spec adds its functions here so the serve handler stays a one-liner.

import { gmailSyncDelta } from "./gmail-sync";

export const inngestFunctions = [gmailSyncDelta];
