import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { auth, signOut } from "@/lib/auth";
import Link from "next/link";

export default async function MailLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <Link href="/inbox" className="text-sm font-semibold tracking-tight">
          Universal Mail
        </Link>
        <div className="flex items-center gap-3">
          <Avatar
            src={session?.user?.image}
            alt={session?.user?.name ?? "Account"}
            fallback={session?.user?.name ?? session?.user?.email ?? "U"}
          />
          <form action={doSignOut}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="hidden w-64 border-r border-zinc-200 bg-white p-4 sm:block">
          {/* Account switcher + label list arrives in spec `unified-inbox-ui`. */}
        </aside>
        <main className="flex-1 bg-zinc-50 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
