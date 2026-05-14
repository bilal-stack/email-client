---
name: spec-template
description: Skeleton and rules for writing a new Agent OS spec under .agent-os/specs/YYYY-MM-DD-name/. Read this before writing any spec.
---

# Spec template

Every spec folder contains five files. Don't skip any; if a section truly doesn't apply, write "N/A" and move on.

```
.agent-os/specs/YYYY-MM-DD-<kebab-name>/
├── spec.md
├── spec-lite.md
├── tasks.md
└── sub-specs/
    ├── technical-spec.md
    ├── database-schema.md
    └── tests.md
```

## `spec.md`
```markdown
# <Feature title>

## Goal
One paragraph. What ships when this spec lands. Include what changes from the user's POV.

## User stories
Numbered list. Each story names a role and an outcome:
1. As a <role>, I can <action> so that <outcome>.

## Non-goals
Explicit. List the things people might assume are in scope that *aren't*.

## In-scope surfaces
- Routes: which URLs change or are added
- Server Actions: function names + signatures (high level)
- Components: which UI surfaces are new or change

## Risks / open questions
Numbered list. Each item: the risk + the chosen mitigation (or "open").

## Definition of done
A short checklist of conditions that must all be true before the spec is closed:
- [ ] Implementation merged
- [ ] Tests pass
- [ ] Security review passed
- [ ] CURRENT_SPEC advanced
```

## `spec-lite.md`
One paragraph (~50–100 words) that captures the goal and the boundaries. This is what AI subagents load when they need a quick context refresh without reading the full spec.

## `tasks.md`
Ordered list of implementation tasks. Each task is something a single specialist agent can complete in one invocation. Mark which agent owns each task.

## `sub-specs/technical-spec.md`
Code snippets, function signatures, integration points, sequence diagrams (ascii if helpful). This is the file the build agent reads to know *exactly* what shape the new code takes.

## `sub-specs/database-schema.md`
The exact Prisma model changes. Include `@@unique` and indexes. If no schema change, write "No schema changes in this spec."

## `sub-specs/tests.md`
Test plan organized as:
- Unit tests (per module, with named cases)
- E2E tests (named scenarios)
- Mocking strategy

`test-author` agent reads only this file.

## Rules
- One spec = one PR's worth of work. If you'd want to split the PR, split the spec.
- Specs are immutable once a build agent starts. Changes in scope require a new spec.
- Specs never depend on future specs. They may depend on prior shipped specs.
- "Out of scope" is a feature; use it.
