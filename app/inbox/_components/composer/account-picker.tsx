"use client";

import { useId } from "react";

export interface AccountOption {
  id: string;
  emailAddress: string;
  displayName: string | null;
}

interface AccountPickerProps {
  value: string;
  options: AccountOption[];
  disabled?: boolean;
  onChange: (id: string) => void;
}

export function AccountPicker({ value, options, disabled, onChange }: AccountPickerProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        From
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:bg-zinc-100 disabled:text-zinc-600"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName ? `${o.displayName} <${o.emailAddress}>` : o.emailAddress}
          </option>
        ))}
      </select>
    </div>
  );
}
