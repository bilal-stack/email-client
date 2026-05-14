// Provider registry. Adapter implementations land here in their respective
// specs (gmail-provider, graph-provider, imap-provider). Until then the only
// member is the NotImplementedProvider stub.

import { type IEmailProvider, NotImplementedProvider } from "./types";

export type ProviderName = "gmail" | "graph" | "imap";

export function getProvider(_name: ProviderName): IEmailProvider {
  return new NotImplementedProvider();
}
