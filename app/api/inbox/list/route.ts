import { auth } from "@/lib/auth";
import { listThreadsForUser } from "@/lib/db/inbox-queries";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const InputSchema = z.object({
  accountId: z.string().cuid().optional(),
  sort: z.enum(["priority", "time"]).optional(),
});

/**
 * GET /api/inbox/list?accountId=&sort=
 *
 * Thin GET mirror of the `listThreads` Server Action. Exists so the PWA
 * service worker can cache the inbox list (Server Actions are POSTs and
 * cannot be safely cached). The UI continues to call the Server Action
 * when online; the SW falls back to this route only when offline.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = InputSchema.safeParse({
    accountId: url.searchParams.get("accountId") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const data = await listThreadsForUser(session.user.id, parsed.data);
  return NextResponse.json(data);
}
