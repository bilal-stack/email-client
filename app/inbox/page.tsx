import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function InboxPage() {
  const session = await auth();
  const accounts = session?.user?.id
    ? await prisma.mailAccount.findMany({
        where: { userId: session.user.id },
        select: { id: true, provider: true, emailAddress: true, displayName: true },
      })
    : [];

  if (accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No mailboxes connected yet</CardTitle>
          <CardDescription>
            You're signed in, but we haven't fetched any mail yet. The Gmail adapter lands in spec{" "}
            <code>gmail-provider</code>; until then this inbox is intentionally empty.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-zinc-600">
            What works today: sign-in flow, encrypted token storage, route gating, Inngest wiring.
            What's next: list, read, send, AI summaries.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected mailboxes</CardTitle>
        <CardDescription>
          The provider adapters haven't shipped yet, so we can't list mail. We can confirm the
          credentials are stored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              <span>{a.emailAddress}</span>
              <span className="text-xs uppercase tracking-wide text-zinc-500">{a.provider}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
