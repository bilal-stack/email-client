import { loadParentForCompose } from "@/app/inbox/[threadId]/_lib/load-parent";
import { Composer } from "@/app/inbox/_components/composer/composer";
import { getDraftForUser } from "@/lib/compose/draft-queries";
import { buildReplyHeaders, prefixReplySubject } from "@/lib/compose/headers";
import type { CanonicalAddress } from "@/lib/providers/types";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface ReplyPageProps {
  params: Promise<{ threadId: string }>;
}

export default async function ReplyPage({ params }: ReplyPageProps) {
  const { threadId } = await params;
  const ctx = await loadParentForCompose(threadId);
  if (!ctx) notFound();

  const headers = buildReplyHeaders({
    providerMessageId: ctx.parent.providerMessageId,
    inReplyTo: ctx.parent.inReplyTo,
    references: ctx.parent.references,
  });
  const subject = prefixReplySubject(ctx.parent.subject);
  const prefilledTo: CanonicalAddress[] = ctx.parent.from.email ? [ctx.parent.from] : [];

  const draftRow = await getDraftForUser(ctx.userId, { threadId, mode: "reply" });
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

  return (
    <div className="grid h-full grid-cols-1">
      <section className="flex min-h-screen flex-col">
        <header className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
          <h1 className="truncate text-lg font-semibold text-zinc-900">Reply</h1>
          <p className="truncate text-xs text-zinc-500">{ctx.thread.subject}</p>
        </header>
        <div className="flex-1">
          <Composer
            mode="reply"
            accountId={ctx.account.id}
            accountOptions={[
              {
                id: ctx.account.id,
                emailAddress: ctx.account.emailAddress,
                displayName: ctx.account.displayName,
              },
            ]}
            threadId={threadId}
            parentMessage={{
              inReplyTo: [headers.inReplyTo],
              references: headers.references,
              prefilledTo,
              prefilledSubject: subject,
            }}
            initialDraft={initialDraft}
          />
        </div>
      </section>
    </div>
  );
}

function jsonAsAddresses(v: unknown): CanonicalAddress[] {
  if (!Array.isArray(v)) return [];
  const out: CanonicalAddress[] = [];
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
