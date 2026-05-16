export default function ComposeNewLoading() {
  return (
    <div className="grid h-full grid-cols-1">
      <section className="flex min-h-screen flex-col">
        <div className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
          <div className="h-6 w-40 animate-pulse rounded bg-zinc-200" />
        </div>
        <div className="flex-1 space-y-4 px-4 py-4 sm:px-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
              key={i}
              className="h-11 w-full animate-pulse rounded-md bg-zinc-100"
            />
          ))}
          <div className="h-48 w-full animate-pulse rounded-md bg-zinc-100" />
        </div>
      </section>
    </div>
  );
}
