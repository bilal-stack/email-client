import { auth } from "@/lib/auth";
import { getThreadByIdForUser } from "@/lib/db/inbox-queries";
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().cuid() });

/**
 * GET /api/inbox/thread/[id]
 *
 * Thin GET mirror of the `getThread` Server Action. Exists so the PWA
 * service worker can cache the per-thread body view (Server Actions are
 * POSTs and cannot be safely cached). The UI continues to call the
 * Server Action when online; the SW falls back to this route only when
 * offline. The shape mirrors the Server Action's `data` payload exactly.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rawParams = await context.params;
  const parsed = ParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const t = await getThreadByIdForUser(session.user.id, parsed.data.id);
  if (!t) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = {
    thread: {
      id: t.id,
      subject: t.subject,
      accountId: t.account.id,
      accountEmail: t.account.emailAddress,
    },
    messages: await Promise.all(
      t.messages.map(async (m) => {
        const fromJson = m.from as unknown as { name?: string; email?: string } | null;
        const toJsonRaw = m.to as unknown;
        const toJson = Array.isArray(toJsonRaw) ? (toJsonRaw as Array<{ email?: string }>) : [];
        return {
          id: m.id,
          fromName: fromJson?.name ?? "",
          fromEmail: fromJson?.email ?? "",
          toLine: toJson
            .map((a) => a.email)
            .filter((e): e is string => Boolean(e))
            .join(", "),
          receivedAt: m.receivedAt,
          bodyHtml: m.bodyHtml ? await sanitizeEmailHtml(m.bodyHtml) : null,
          bodyText: m.bodyText,
          attachments: m.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            size: a.size,
            mimeType: a.mimeType,
          })),
        };
      }),
    ),
  };

  return NextResponse.json(data);
}
