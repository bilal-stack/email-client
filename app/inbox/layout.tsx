import { ComposeButton } from "@/app/inbox/_components/compose-button";
import { InboxEventsListener } from "@/app/inbox/_components/inbox-events-listener";
import { MailboxNavList } from "@/app/inbox/_components/mailbox-nav-list";
import { OutboxStatus } from "@/app/inbox/_components/outbox-status";
import { InboxQueryProvider } from "@/app/inbox/_components/query-provider";
import { SearchInput } from "@/app/inbox/_components/search-input";
import { Avatar } from "@/components/ui/avatar";
import { SubmitButton } from "@/components/ui/submit-button";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Plus } from "lucide-react";
import Link from "next/link";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const accounts = session?.user?.id
    ? await prisma.mailAccount.findMany({
        where: { userId: session.user.id },
        select: { id: true, emailAddress: true, displayName: true, provider: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <InboxQueryProvider>
      {/* SSE listener at the layout level so it's active across every
        inbox-scoped route — inbox list, thread view, compose, drafts —
        and so background-send completion events arrive even when the
        user navigates away from the compose page in between click-Send
        and worker-completes. (Previously only mounted inside ThreadList,
        which left mobile thread views + the compose page deaf to SSE.) */}
      <InboxEventsListener />
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-3">
          <Link href="/inbox" className="shrink-0 text-sm font-semibold tracking-tight">
            Universal Mail
          </Link>
          <div className="hidden flex-1 sm:block">
            <SearchInput />
          </div>
          <div className="flex items-center gap-3">
            <OutboxStatus />
            <ComposeButton />
            <Avatar
              src={session?.user?.image}
              alt={session?.user?.name ?? "Account"}
              fallback={session?.user?.name ?? session?.user?.email ?? "U"}
            />
            <form action={doSignOut}>
              <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </header>
        <div className="flex flex-1">
          <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white p-4 md:block">
            <div className="space-y-1">
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Mailboxes
              </p>
              <MailboxNavList accounts={accounts} />
              {/* Add-mailbox CTA — separate from the nav list because it's not
                a filter, it's a connect-another-account action. Same visual
                language as the existing AccountSwitcher's "+" pill. */}
              <Link
                href="/signin?add=1"
                className="mt-2 inline-flex w-full items-center gap-2 rounded-md border border-dashed border-zinc-300 px-2 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Add mailbox</span>
              </Link>
            </div>
          </aside>
          <main className="flex-1 bg-zinc-50">{children}</main>
        </div>
      </div>
    </InboxQueryProvider>
  );
}
