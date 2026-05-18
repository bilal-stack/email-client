import { AccountSwitcher } from "@/app/inbox/_components/account-switcher";
import { SortToggle } from "@/app/inbox/_components/sort-toggle";
import { ThreadList } from "@/app/inbox/_components/thread-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { type InboxSort, listThreadsForUser } from "@/lib/db/inbox-queries";
import Link from "next/link";

interface InboxPageProps {
  searchParams: Promise<{ account?: string; sort?: string }>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>
              You need to be signed in to view your inbox.{" "}
              <Link className="underline" href="/signin">
                Sign in
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  const userId = session.user.id;
  const { account: accountParam, sort: sortParam } = await searchParams;
  const activeAccountId = accountParam ?? null;
  const sort: InboxSort = sortParam === "time" ? "time" : "priority";

  const accounts = await prisma.mailAccount.findMany({
    where: { userId },
    select: { id: true, emailAddress: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });

  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>No mailboxes connected yet</CardTitle>
            <CardDescription>
              You're signed in, but no mailboxes are connected. Connect one to start receiving mail.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link className="text-sm font-medium underline" href="/signin">
              Connect a mailbox
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const initial = await listThreadsForUser(userId, {
    ...(activeAccountId ? { accountId: activeAccountId } : {}),
    sort,
  });

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="flex min-h-[60vh] flex-col border-zinc-200 md:border-r">
        <div className="space-y-3 border-b border-zinc-200 bg-white p-4">
          <AccountSwitcher accounts={accounts} active={activeAccountId} />
          <div className="flex justify-stretch sm:justify-end">
            <SortToggle />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ThreadList accountId={activeAccountId} initial={initial} sort={sort} />
        </div>
      </section>
      <section className="hidden items-center justify-center p-12 text-center md:flex">
        <div className="max-w-sm">
          <p className="text-sm font-medium text-zinc-700">Pick a thread to read</p>
          <p className="mt-1 text-xs text-zinc-500">
            Threads open here. New mail arrives automatically — no refresh needed.
          </p>
        </div>
      </section>
    </div>
  );
}
