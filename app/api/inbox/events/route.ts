import { auth } from "@/lib/auth";
import {
  type InboxSseEvent,
  subscribeInboxSyncEvents,
} from "@/lib/realtime/inbox-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const onEvent = (e: InboxSseEvent) => {
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      const unsubscribe = subscribeInboxSyncEvents(userId, onEvent);

      safeEnqueue(encoder.encode(": connected\n\n"));

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 25_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
