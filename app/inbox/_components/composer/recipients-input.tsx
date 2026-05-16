"use client";

import { formatAddressList, isValidEmail, parseAddressList } from "@/lib/compose/parse-addresses";
import type { CanonicalAddress } from "@/lib/providers/types";
import { useEffect, useId, useState } from "react";

interface RecipientsInputProps {
  label: string;
  value: CanonicalAddress[];
  onChange: (next: CanonicalAddress[]) => void;
}

/**
 * Comma-separated text input that parses to `CanonicalAddress[]` on blur via
 * the shared `parseAddressList`. Chips render the parsed value; the raw text
 * stays editable so the user sees what they typed until they tab away.
 */
export function RecipientsInput({ label, value, onChange }: RecipientsInputProps) {
  const id = useId();
  const [text, setText] = useState(() => formatAddressList(value));

  // When the external value changes (e.g. initial draft load), reflect it
  // back into the text — but only when the parsed-out value differs, so we
  // don't trample a user mid-type.
  useEffect(() => {
    const formatted = formatAddressList(value);
    setText((prev) => {
      const parsed = parseAddressList(prev);
      const same =
        parsed.length === value.length &&
        parsed.every((a, i) => a.email.toLowerCase() === value[i]?.email.toLowerCase());
      return same ? prev : formatted;
    });
  }, [value]);

  function commit(raw: string) {
    const next = parseAddressList(raw);
    onChange(next);
  }

  const parsed = parseAddressList(text);
  const invalid = parsed.filter((a) => !isValidEmail(a.email));

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        placeholder="name@example.com, …"
        className="min-h-[44px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        autoComplete="off"
      />
      {invalid.length > 0 ? (
        <p className="text-xs text-red-600">
          Invalid address: {invalid.map((a) => a.email).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
