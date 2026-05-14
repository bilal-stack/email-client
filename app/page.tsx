import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-12 px-6 py-12 sm:py-20">
      <header className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">Universal Mail</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          One inbox. Every provider. AI that reads first.
        </h1>
        <p className="max-w-xl text-lg text-zinc-600">
          Gmail, Office 365, and IMAP behind one interface. Claude summarizes threads, prioritizes
          new mail, and drafts replies in your voice.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Sign in to get started</CardTitle>
          <CardDescription>
            Connect a mailbox to start using the inbox. You can add more accounts later.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button asChild>
            <Link href="/signin?provider=google">Sign in with Google</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/signin?provider=microsoft-entra-id">Sign in with Microsoft</Link>
          </Button>
          <Button variant="ghost" disabled title="Coming soon (spec: imap-provider)">
            Use IMAP (coming soon)
          </Button>
        </CardContent>
      </Card>

      <footer className="text-sm text-zinc-500">
        Built with Claude Code. AI calls are server-only. Tokens encrypted at rest.
      </footer>
    </main>
  );
}
