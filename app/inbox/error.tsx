"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useEffect } from "react";

export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Inbox error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Something went wrong loading your inbox</CardTitle>
          <CardDescription>
            {error.message || "An unexpected error occurred. Try again in a moment."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" onClick={reset}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
