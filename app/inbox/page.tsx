import { AccountSwitcher } from "@/app/inbox/_components/account-switcher";
import { DraftList } from "@/app/inbox/_components/draft-list";
import { FolderNav } from "@/app/inbox/_components/folder-nav";
import { SortToggle } from "@/app/inbox/_components/sort-toggle";
import { ThreadList } from "@/app/inbox/_components/thread-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  type InboxFolder,
  type InboxSort,
  listDraftsForUser,
  listThreadsForUser,
} from "@/lib/db/inbox-queries";
import Link from "next/link";

interface InboxPageProps {
  searchParams: Promise<{ account?: string; sort?: string; folder?: string }>;
}

const FOLDER_LABELS: Record<InboxFolder | "drafts", string> = {
  inbox: "Inbox",
  sent: "Sent",
  archived: "Archived",
  spam: "Spam",
  trash: "Trash",
  all: "All mail",
  drafts: "Drafts",
};

function parseFolder(raw: string | undefined): InboxFolder | "drafts" {
  switch (raw) {
    case "sent":
    case "archived":
    case "spam":
    case "trash":
    case "all":
    case "drafts":
      return raw;
    default:
      return "inbox";
  }
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
              <Link className="underline" href="/login">
                Log in
              </Link>{" "}
              or{" "}
              <Link className="underline" href="/signup">
                sign up
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  const userId = session.user.id;
  const {
    account: accountParam,
    sort: sortParam,
    folder: folderParam,
  } = await searchParams;
  const activeAccountId = accountParam ?? null;
  const sort: InboxSort = sortParam === "time" ? "time" : "priority";
  const folder = parseFolder(folderParam);

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
            <Link className="text-sm font-medium underline" href="/signin?add=1">
              Connect a mailbox
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Drafts is the only folder whose row data sources from the `Draft` table.
  // Every other folder is a label-filtered slice of `Thread`, served by the
  // same `listThreadsForUser` query that powers the default inbox.
  const initialDrafts =
    folder === "drafts"
      ? await listDraftsForUser(userId, {
          ...(activeAccountId ? { accountId: activeAccountId } : {}),
        })
      : null;
  const initialThreads =
    folder === "drafts"
      ? { threads: [], nextCursor: null }
      : await listThreadsForUser(userId, {
          ...(activeAccountId ? { accountId: activeAccountId } : {}),
          sort,
          folder,
        });

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="flex min-h-[60vh] flex-col border-zinc-200 md:border-r">
        <div className="space-y-3 border-b border-zinc-200 bg-white p-4">
          <AccountSwitcher accounts={accounts} active={activeAccountId} />
          <FolderNav active={folder} />
          {folder !== "drafts" ? (
            <div className="flex justify-stretch sm:justify-end">
              <SortToggle />
            </div>
          ) : null}
          <h1 className="sr-only">{FOLDER_LABELS[folder]}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          {folder === "drafts" ? (
            <DraftList accountId={activeAccountId} initial={initialDrafts!} />
          ) : (
            <ThreadList
              accountId={activeAccountId}
              initial={initialThreads}
              sort={sort}
              folder={folder}
            />
          )}
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
