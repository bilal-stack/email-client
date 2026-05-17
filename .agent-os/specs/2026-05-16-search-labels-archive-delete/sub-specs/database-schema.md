# Database Schema — Search, Labels, Archive, Delete

**No schema changes in this spec.**

All operations work on the existing `Thread`, `Message`, and `Attachment` tables. Labels live in `Thread.labels` (Json array of strings) and `Message.labels` (same); archive removes `"INBOX"`, trash adds `"TRASH"` and removes `"INBOX"`.

A migration would be required for either of these (deferred):

- **Postgres-native `WHERE labels @> '["INBOX"]'` filter.** Faster than the JS-side filter the spec uses today. Lands with `deploy-vercel` when the DB type switches.
- **Promoting `labels` to a join table** (`ThreadLabel` with `threadId` + `name`). Would enable real-time concurrent label updates without last-write-wins. Out of scope for the eval; not on the roadmap.
