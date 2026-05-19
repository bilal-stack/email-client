import { MarkReadTrigger } from "@/app/inbox/[threadId]/_components/mark-read-trigger";
import { ThreadView } from "@/app/inbox/[threadId]/_components/thread-view";
import { AccountSwitcher } from "@/app/inbox/_components/account-switcher";
import { ThreadList } from "@/app/inbox/_components/thread-list";
import { getThread } from "@/app/inbox/actions";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { listThreadsForUser } from "@/lib/db/inbox-queries";
import Link from "next/link";
import { notFound } from "next/navigation";

// This route reads session + DB on every request and renders sanitized email
// HTML — there's no value in static collection. Forcing dynamic also avoids a
// known `isomorphic-dompurify` bundling issue (default-stylesheet.css ENOENT)
// during Next's page-data collection phase.
export const dynamic = "force-dynamic";

interface ThreadPageProps {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ account?: string }>;
}

export default async function ThreadPage({ params, searchParams }: ThreadPageProps) {
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
  const { threadId } = await params;
  const { account: accountParam } = await searchParams;
  const activeAccountId = accountParam ?? null;

  const result = await getThread({ threadId });
  if (!result.ok) {
    if (result.error === "Not found" || result.error === "Invalid input") notFound();
    throw new Error(result.error);
  }

  const accounts = await prisma.mailAccount.findMany({
    where: { userId },
    select: { id: true, emailAddress: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });
  const initialList = await listThreadsForUser(userId, {
    ...(activeAccountId ? { accountId: activeAccountId } : {}),
  });

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      {/* Left pane: list (hidden on mobile when reading a thread). */}
      <section className="hidden flex-col border-r border-zinc-200 md:flex">
        <div className="border-b border-zinc-200 bg-white p-4">
          <AccountSwitcher accounts={accounts} active={activeAccountId} />
        </div>
        <div className="flex-1 overflow-y-auto">
          <ThreadList
            accountId={activeAccountId}
            initial={initialList}
            selectedThreadId={threadId}
          />
        </div>
      </section>
      {/* Right pane: thread. */}
      <section className="flex min-h-screen flex-col">
        <ThreadView thread={result.data.thread} messages={result.data.messages} />
        <MarkReadTrigger threadId={threadId} />
      </section>
    </div>
  );
}
