"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { useEffect } from "react";

export default function ReplyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Reply error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Couldn't open the reply composer</CardTitle>
          <CardDescription>
            {error.message || "An unexpected error occurred. Try again in a moment."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/inbox">Back to inbox</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
