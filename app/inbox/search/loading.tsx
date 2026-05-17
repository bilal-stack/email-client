import { Loader2 } from "lucide-react";

export default function SearchLoading() {
  return (
    <div className="flex h-full items-center justify-center p-12 text-sm text-zinc-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      <span>Searching mail…</span>
    </div>
  );
}
