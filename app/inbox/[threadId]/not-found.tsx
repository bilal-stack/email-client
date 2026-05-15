import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

export default function ThreadNotFound() {
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Thread not found</CardTitle>
          <CardDescription>
            This thread doesn't exist, or it isn't in one of your connected mailboxes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/inbox">Back to inbox</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
