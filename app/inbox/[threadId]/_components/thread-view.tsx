import { MessageCard } from "@/app/inbox/[threadId]/_components/message-card";
import { ThreadActions } from "@/app/inbox/[threadId]/_components/thread-actions";
import type { ThreadDTO, ThreadMessageDTO } from "@/app/inbox/_lib/dto";
import { Button } from "@/components/ui/button";
import Link from "next/link";

interface ThreadViewProps {
  thread: ThreadDTO;
  messages: ThreadMessageDTO[];
}

function countRecipientsOnLatest(messages: ThreadMessageDTO[], ownAddress: string): number {
  const latest = messages[messages.length - 1];
  if (!latest) return 0;
  const emails = latest.toLine
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.toLowerCase() !== ownAddress.toLowerCase());
  return emails.length;
}

export function ThreadView({ thread, messages }: ThreadViewProps) {
  const showReplyAll = countRecipientsOnLatest(messages, thread.accountEmail) > 1;
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-start gap-3 border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
        <Link
          href="/inbox"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 md:hidden"
          aria-label="Back to inbox"
        >
          <span aria-hidden>&larr;</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-zinc-900">
            {thread.subject || "(no subject)"}
          </h1>
          <p className="truncate text-xs text-zinc-500">
            {messages.length} {messages.length === 1 ? "message" : "messages"} ·{" "}
            {thread.accountEmail}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/inbox/${thread.id}/reply`}>Reply</Link>
          </Button>
          {showReplyAll ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/inbox/${thread.id}/reply-all`}>Reply all</Link>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/inbox/${thread.id}/forward`}>Forward</Link>
          </Button>
          <ThreadActions threadId={thread.id} />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">This thread has no messages cached yet.</p>
        ) : (
          messages.map((m) => <MessageCard key={m.id} message={m} />)
        )}
      </div>
    </div>
  );
}
