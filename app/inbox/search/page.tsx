import { ThreadList } from "@/app/inbox/_components/thread-list";
import { searchThreads } from "@/app/inbox/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { redirect } from "next/navigation";

// Search reads session + DB on every request and the result set is
// per-user; nothing here is statically prerenderable.
export const dynamic = "force-dynamic";

interface SearchPageProps {
  searchParams: Promise<{ q?: string; account?: string }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { q = "", account } = await searchParams;
  const trimmed = q.trim();

  if (trimmed.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Type a query to search</CardTitle>
            <CardDescription>
              Use the search bar in the header. Power-user syntax like
              <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 text-xs">from:bob</code>
              or
              <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 text-xs">has:attachment</code>
              is passed through to your provider.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/inbox" className="text-sm font-medium underline">
              Back to inbox
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const result = await searchThreads({
    query: trimmed,
    ...(account ? { accountId: account } : {}),
  });
  if (!result.ok) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle>Search failed</CardTitle>
            <CardDescription>{result.error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section className="flex min-h-[60vh] flex-col border-zinc-200 md:border-r">
        <div className="border-b border-zinc-200 bg-white p-4">
          <p className="text-xs text-zinc-500">
            <span className="font-medium text-zinc-700">{result.data.threads.length}</span> results
            for <span className="font-medium text-zinc-700">"{trimmed}"</span>
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ThreadList accountId={null} initial={result.data} />
        </div>
      </section>
      <section className="hidden items-center justify-center p-12 text-center md:flex">
        <div className="max-w-sm">
          <p className="text-sm font-medium text-zinc-700">Pick a thread to read</p>
          <p className="mt-1 text-xs text-zinc-500">
            Search results behave the same as inbox rows — click to open, hover for archive / trash,
            select to bulk-act.
          </p>
        </div>
      </section>
    </div>
  );
}
