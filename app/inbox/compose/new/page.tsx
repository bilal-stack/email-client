import { Composer } from "@/app/inbox/_components/composer/composer";
import { auth } from "@/lib/auth";
import { getDraftForUser } from "@/lib/compose/draft-queries";
import { prisma } from "@/lib/db";
import Link from "next/link";

// Reads session + DB on every request — also keeps `isomorphic-dompurify` out
// of Next's page-data collection (see [threadId]/page.tsx for prior art).
export const dynamic = "force-dynamic";

interface ComposeNewPageProps {
  searchParams: Promise<{ accountId?: string }>;
}

export default async function ComposeNewPage({ searchParams }: ComposeNewPageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    return (
      <div className="p-6 text-sm text-zinc-600">
        You need to be signed in. <Link href="/login">Log in</Link> or{" "}
        <Link href="/signup">sign up</Link>.
      </div>
    );
  }
  const userId = session.user.id;
  const { accountId: accountIdParam } = await searchParams;

  const accounts = await prisma.mailAccount.findMany({
    where: { userId },
    select: { id: true, emailAddress: true, displayName: true, lastSyncedAt: true },
    orderBy: [{ lastSyncedAt: "desc" }, { createdAt: "asc" }],
  });

  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-sm text-zinc-600">
        Connect a mailbox first to compose a message.
      </div>
    );
  }

  const selectedId =
    accountIdParam && accounts.some((a) => a.id === accountIdParam)
      ? accountIdParam
      : (accounts[0]?.id ?? "");

  const draftRow = await getDraftForUser(userId, { threadId: null, mode: "new" });

  const initialDraft = draftRow
    ? {
        id: draftRow.id,
        to: jsonAsAddresses(draftRow.to),
        cc: jsonAsAddresses(draftRow.cc),
        bcc: jsonAsAddresses(draftRow.bcc),
        subject: draftRow.subject,
        bodyHtml: draftRow.bodyHtml,
      }
    : null;

  const composerAccountId = draftRow?.accountId ?? selectedId;

  return (
    <div className="grid h-full grid-cols-1">
      <section className="flex min-h-screen flex-col">
        <header className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
          <h1 className="text-lg font-semibold text-zinc-900">New message</h1>
        </header>
        <div className="flex-1">
          <Composer
            mode="new"
            accountId={composerAccountId}
            accountOptions={accounts.map((a) => ({
              id: a.id,
              emailAddress: a.emailAddress,
              displayName: a.displayName,
            }))}
            initialDraft={initialDraft}
          />
        </div>
      </section>
    </div>
  );
}

function jsonAsAddresses(v: unknown): Array<{ name?: string; email: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ name?: string; email: string }> = [];
  for (const raw of v) {
    if (raw && typeof raw === "object") {
      const r = raw as { name?: unknown; email?: unknown };
      if (typeof r.email === "string") {
        out.push(
          typeof r.name === "string" ? { name: r.name, email: r.email } : { email: r.email },
        );
      }
    }
  }
  return out;
}
