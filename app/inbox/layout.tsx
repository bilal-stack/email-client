import { ComposeButton } from "@/app/inbox/_components/compose-button";
import { InboxQueryProvider } from "@/app/inbox/_components/query-provider";
import { SearchInput } from "@/app/inbox/_components/search-input";
import { Avatar } from "@/components/ui/avatar";
import { SubmitButton } from "@/components/ui/submit-button";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import Link from "next/link";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const accounts = session?.user?.id
    ? await prisma.mailAccount.findMany({
        where: { userId: session.user.id },
        select: { id: true, emailAddress: true, displayName: true, provider: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <InboxQueryProvider>
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-3">
          <Link href="/inbox" className="shrink-0 text-sm font-semibold tracking-tight">
            Universal Mail
          </Link>
          <div className="hidden flex-1 sm:block">
            <SearchInput />
          </div>
          <div className="flex items-center gap-3">
            <ComposeButton />
            <Avatar
              src={session?.user?.image}
              alt={session?.user?.name ?? "Account"}
              fallback={session?.user?.name ?? session?.user?.email ?? "U"}
            />
            <form action={doSignOut}>
              <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </header>
        <div className="flex flex-1">
          <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white p-4 md:block">
            <div className="space-y-1">
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Mailboxes
              </p>
              <ul className="mt-2 space-y-1">
                {accounts.length === 0 ? (
                  <li className="px-2 py-1 text-xs text-zinc-500">No accounts connected.</li>
                ) : (
                  accounts.map((a) => (
                    <li
                      key={a.id}
                      className="truncate rounded-md px-2 py-1 text-sm text-zinc-700"
                      title={a.emailAddress}
                    >
                      <span className="block truncate">{a.displayName ?? a.emailAddress}</span>
                      {a.displayName ? (
                        <span className="block truncate text-xs text-zinc-500">
                          {a.emailAddress}
                        </span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </div>
          </aside>
          <main className="flex-1 bg-zinc-50">{children}</main>
        </div>
      </div>
    </InboxQueryProvider>
  );
}
