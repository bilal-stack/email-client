import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function LandingPage() {
  // Signed-in users skip the marketing landing and go straight to their inbox.
  const session = await auth();
  if (session?.user) redirect("/inbox");

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
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            New here? Create an account. Already have one? Log in. Either way, you'll pick a
            mailbox provider on the next screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Button asChild className="sm:flex-1">
            <Link href="/login">Log in</Link>
          </Button>
          <Button asChild variant="outline" className="sm:flex-1">
            <Link href="/signup">Sign up</Link>
          </Button>
        </CardContent>
      </Card>

      <footer className="text-sm text-zinc-500">
        Built with Claude Code. AI calls are server-only. Tokens encrypted at rest.
      </footer>
    </main>
  );
}
