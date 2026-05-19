"use client";

// IMAP sign-in form. Posts the four credential fields (plus optional ports)
// to Auth.js's `signIn("imap", ...)` Credentials handler via a Server Action
// passed in as a prop. Includes a Yahoo / AOL preset selector that fills in
// the IMAP + SMTP host fields so the user doesn't have to remember them.
//
// The form is hidden by default behind a disclosure button — Google +
// Microsoft are the primary path; IMAP is the fallback for Yahoo / AOL /
// arbitrary IMAP servers.

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import { ChevronDown, Mail } from "lucide-react";
import { useId, useState } from "react";

interface ImapSignInFormProps {
  action: (formData: FormData) => Promise<void>;
}

interface Preset {
  id: string;
  label: string;
  imapHost: string;
  smtpHost: string;
}

const PRESETS: Preset[] = [
  {
    id: "yahoo",
    label: "Yahoo Mail",
    imapHost: "imap.mail.yahoo.com",
    smtpHost: "smtp.mail.yahoo.com",
  },
  {
    id: "aol",
    label: "AOL Mail",
    imapHost: "imap.aol.com",
    smtpHost: "smtp.aol.com",
  },
  {
    id: "custom",
    label: "Other / custom",
    imapHost: "",
    smtpHost: "",
  },
];

export function ImapSignInForm({ action }: ImapSignInFormProps) {
  const [open, setOpen] = useState(false);
  const [presetId, setPresetId] = useState<Preset["id"]>("yahoo");
  const [imapHost, setImapHost] = useState(PRESETS[0]!.imapHost);
  const [smtpHost, setSmtpHost] = useState(PRESETS[0]!.smtpHost);
  const emailId = useId();
  const passwordId = useId();
  const imapHostId = useId();
  const smtpHostId = useId();

  function pickPreset(id: Preset["id"]) {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0]!;
    setPresetId(id);
    setImapHost(p.imapHost);
    setSmtpHost(p.smtpHost);
  }

  return (
    <div className="rounded-md border border-zinc-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-zinc-700",
          "hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
          open && "border-b border-zinc-200",
        )}
      >
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4" aria-hidden="true" />
          Continue with IMAP (Yahoo / AOL / other)
        </span>
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <form action={action} className="space-y-3 px-4 py-3">
          <div>
            <label className="text-xs font-medium text-zinc-700" htmlFor="imap-preset">
              Email provider
            </label>
            <div
              id="imap-preset"
              role="radiogroup"
              aria-label="Email provider preset"
              className="mt-1 flex flex-wrap gap-2"
            >
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={presetId === p.id}
                  onClick={() => pickPreset(p.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs",
                    presetId === p.id
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-700" htmlFor={emailId}>
              Email address
            </label>
            <input
              id={emailId}
              name="emailAddress"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-700" htmlFor={passwordId}>
              App password
            </label>
            <input
              id={passwordId}
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
              placeholder="16-char app password (NOT your regular password)"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Yahoo / AOL: generate at <strong>Account security → App passwords</strong>.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-zinc-700" htmlFor={imapHostId}>
                IMAP host
              </label>
              <input
                id={imapHostId}
                name="imapHost"
                type="text"
                required
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-700" htmlFor={smtpHostId}>
                SMTP host
              </label>
              <input
                id={smtpHostId}
                name="smtpHost"
                type="text"
                required
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
              />
            </div>
          </div>

          <p className="text-xs text-zinc-500">
            Ports default to 993 (IMAP) and 465 (SMTP); TLS required.
          </p>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Connecting…">Connect mailbox</SubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}
