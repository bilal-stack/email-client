# Product Mission

## Pitch
An AI-first universal email client. One inbox for Gmail, Office 365, and IMAP (Yahoo, AOL), with Claude doing the heavy reading: per-thread summaries, priority scoring on every new message, and draft replies that match how the user actually writes.

## Who it's for
- Power users juggling two or more email accounts who triage daily.
- Anyone burned out on inbox volume who wants AI to surface what matters.

## The problem
Email volume is high, signal is low. Native clients show every message with equal weight. Existing "AI email" tools tend to live in *one* provider's UI or charge per seat for a single vendor. People run multiple mailboxes and want one place where AI helps across all of them.

## How we win
- **Universal**: Gmail, O365, and IMAP behind one provider interface. UI and AI never branch on provider.
- **AI-first, not AI-bolted**: prioritization runs on every new message during sync; summaries are cached the first time a thread is opened; drafts stream. AI is in the flow, not a sidebar.
- **PWA**: installable, mobile-first, offline-capable. No app-store gate.
- **Privacy-respecting**: tokens encrypted at rest, AI calls server-only, no third parties beyond Anthropic and the email providers.

## Out of scope (explicit, project-wide)
No calendar, contacts, tasks, notes, CRM, scheduling, or mail-rules UI. Email only.

## Success criteria (for this evaluation)
1. All three providers working with parity on the core actions: list, read, send, archive, label, delete, search.
2. Three AI features live: summary, prioritize, draft — each with prompt caching and (where user-facing) streaming.
3. Mobile-ready PWA installable from a deployed Vercel URL.
4. Spec-driven build, end to end, traceable from CLAUDE.md → spec → commit → test.
