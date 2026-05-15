export default function InboxLoading() {
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="flex flex-col border-zinc-200 md:border-r">
        <div className="border-b border-zinc-200 bg-white p-4">
          <div className="flex gap-2">
            <div className="h-10 w-28 animate-pulse rounded-full bg-zinc-200" />
            <div className="h-10 w-40 animate-pulse rounded-full bg-zinc-100" />
          </div>
        </div>
        <ul className="divide-y divide-zinc-100">
          {Array.from({ length: 8 }).map((_, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
              key={i}
              className="flex items-start gap-3 bg-white px-4 py-3"
            >
              <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-zinc-200" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-200" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-100" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-100" />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="hidden p-12 md:block" />
    </div>
  );
}
