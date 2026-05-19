import { ImapSignInForm } from "@/app/signin/_components/imap-signin-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { auth, signIn } from "@/lib/auth";
import Link from "next/link";
import { redirect } from "next/navigation";

interface LoginPageProps {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

function describeError(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "ScopeMissing":
      return "You signed in but didn't grant Gmail access. The app needs the Gmail permission to read and send mail. Click Continue with Google and accept the Gmail permission this time.";
    case "AccessDenied":
      return "Sign-in was cancelled or denied. Try again and grant the requested permissions.";
    case "Configuration":
      return "The server is misconfigured (likely a missing env var). Check the dev server console for details.";
    case "CredentialsSignin":
      return "Couldn't connect with those IMAP credentials. Double-check the app password (16 chars, no spaces) and the IMAP / SMTP host.";
    default:
      return `Sign-in failed: ${code}`;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { callbackUrl = "/inbox", error } = await searchParams;
  // Already signed in? Skip the picker.
  const session = await auth();
  if (session?.user) {
    redirect(callbackUrl.startsWith("/") ? callbackUrl : "/inbox");
  }
  const errorMessage = describeError(error);

  async function googleSignIn() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }
  async function microsoftSignIn() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
  }
  async function imapSignIn(formData: FormData) {
    "use server";
    await signIn("imap", {
      redirectTo: callbackUrl,
      emailAddress: formData.get("emailAddress"),
      password: formData.get("password"),
      imapHost: formData.get("imapHost"),
      smtpHost: formData.get("smtpHost"),
    });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch justify-center px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Log in</CardTitle>
          <CardDescription>
            Pick the provider you signed up with. We'll resume your account and bring back your
            connected mailboxes.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {errorMessage ? (
            <div
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              {errorMessage}
            </div>
          ) : null}
          <form action={googleSignIn}>
            <SubmitButton className="w-full" pendingLabel="Redirecting to Google…">
              Continue with Google
            </SubmitButton>
          </form>
          <form action={microsoftSignIn}>
            <SubmitButton
              variant="outline"
              className="w-full"
              pendingLabel="Redirecting to Microsoft…"
            >
              Continue with Microsoft
            </SubmitButton>
          </form>
          <ImapSignInForm action={imapSignIn} />
          <p className="pt-3 text-center text-sm text-zinc-600">
            New here?{" "}
            <Link href="/signup" className="font-medium text-zinc-900 underline">
              Create an account
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
