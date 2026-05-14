import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signIn } from "@/lib/auth";

interface SignInPageProps {
  searchParams: Promise<{ provider?: string; callbackUrl?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl = "/inbox" } = await searchParams;

  async function googleSignIn() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }
  async function microsoftSignIn() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch justify-center px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Pick a provider. Tokens are encrypted at rest.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form action={googleSignIn}>
            <Button type="submit" className="w-full">
              Continue with Google
            </Button>
          </form>
          <form action={microsoftSignIn}>
            <Button type="submit" variant="outline" className="w-full">
              Continue with Microsoft
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
