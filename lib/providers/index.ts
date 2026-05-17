// Provider registry. Selects an adapter from a `MailAccount.provider` string.
// All three adapters (Gmail, Graph, IMAP) are now wired.

import { prisma } from "@/lib/db";
import { GmailProvider } from "./gmail";
import { GraphProvider } from "./graph";
import { ImapProvider } from "./imap";
import { type IEmailProvider, NotImplementedProvider } from "./types";

export type ProviderName = "gmail" | "graph" | "imap";

/**
 * Returns an `IEmailProvider` for a given account id. Reads the
 * `MailAccount.provider` column and branches on it.
 *
 * Throws if the account doesn't exist (via `findUniqueOrThrow`).
 */
export async function getProviderForAccount(accountId: string): Promise<IEmailProvider> {
  const row = await prisma.mailAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { provider: true },
  });
  return buildProvider(row.provider as ProviderName, accountId);
}

/**
 * Construct a provider for a known name + accountId. Kept as a thin wrapper
 * so callers that already know both can skip the DB lookup (e.g. the Inngest
 * sync function which already has the row in hand).
 */
export function buildProvider(name: ProviderName, accountId: string): IEmailProvider {
  switch (name) {
    case "gmail":
      return new GmailProvider(accountId);
    case "graph":
      return new GraphProvider(accountId);
    case "imap":
      return new ImapProvider(accountId);
    default:
      return new NotImplementedProvider();
  }
}
