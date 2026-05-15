export default function ThreadLoading() {
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="hidden border-r border-zinc-200 md:block">
        <div className="border-b border-zinc-200 bg-white p-4">
          <div className="h-10 w-32 animate-pulse rounded-full bg-zinc-200" />
        </div>
      </section>
      <section className="flex min-h-screen flex-col">
        <div className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6">
          <div className="h-5 w-2/3 animate-pulse rounded bg-zinc-200" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-zinc-100" />
        </div>
        <div className="space-y-4 p-4 sm:p-6">
          <div className="h-32 w-full animate-pulse rounded-md bg-zinc-100" />
          <div className="h-48 w-full animate-pulse rounded-md bg-zinc-100" />
        </div>
      </section>
    </div>
  );
}
