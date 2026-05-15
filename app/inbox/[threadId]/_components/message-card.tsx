import { SandboxIframe } from "@/app/inbox/[threadId]/_components/sandbox-iframe";
import type { ThreadMessageDTO } from "@/app/inbox/_lib/dto";
import { Avatar } from "@/components/ui/avatar";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MessageCard({ message }: { message: ThreadMessageDTO }) {
  const senderName = message.fromName || message.fromEmail || "(unknown sender)";
  return (
    <article className="border-b border-zinc-200 bg-white">
      <header className="flex items-start gap-3 px-4 py-4 sm:px-6">
        <Avatar fallback={senderName} className="mt-0.5 h-10 w-10" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-900">{senderName}</p>
              {message.fromEmail && message.fromName ? (
                <p className="truncate text-xs text-zinc-500">{message.fromEmail}</p>
              ) : null}
            </div>
            <time className="shrink-0 text-xs text-zinc-500">
              {formatDateTime(message.receivedAt)}
            </time>
          </div>
          {message.toLine ? (
            <p className="mt-1 truncate text-xs text-zinc-500">
              <span className="font-medium text-zinc-600">to</span> {message.toLine}
            </p>
          ) : null}
        </div>
      </header>
      <div className="px-4 pb-4 sm:px-6">
        {message.bodyHtml ? (
          <SandboxIframe html={message.bodyHtml} />
        ) : message.bodyText ? (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-sm text-zinc-800">
            {message.bodyText}
          </pre>
        ) : (
          <p className="text-sm italic text-zinc-500">(no body)</p>
        )}
      </div>
      {message.attachments.length > 0 ? (
        <footer className="flex flex-wrap gap-2 border-t border-zinc-100 bg-zinc-50 px-4 py-3 sm:px-6">
          {message.attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700"
              title={`${a.filename} (${a.mimeType})`}
            >
              <span className="max-w-[200px] truncate font-medium">{a.filename}</span>
              <span className="text-zinc-500">{formatBytes(a.size)}</span>
            </span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}
