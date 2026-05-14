#!/usr/bin/env node
// PostToolUse hook for Edit | Write | MultiEdit.
// - If a .ts / .tsx file changed: run `npm run typecheck` and surface failures.
// - If prisma/schema.prisma changed: remind to run `npm run db:migrate`.

import { execSync } from "node:child_process";

let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  payload += chunk;
});
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    process.exit(0);
  }
  const filePath = event?.tool_input?.file_path ?? "";
  const reminders = [];

  if (/\.(ts|tsx)$/i.test(filePath)) {
    try {
      execSync("npm run -s typecheck", { stdio: "pipe", timeout: 60_000, encoding: "utf8" });
    } catch (err) {
      reminders.push(
        `[typecheck] failed after editing ${filePath}. Run \`npm run typecheck\` and fix before continuing.\n${err?.stdout ?? ""}\n${err?.stderr ?? ""}`.trim(),
      );
    }
  }

  if (/prisma[\\/]schema\.prisma$/i.test(filePath)) {
    reminders.push(
      "[prisma] Schema changed. Run `npm run db:migrate` to create/apply a migration before further edits.",
    );
  }

  if (reminders.length > 0) {
    console.error(reminders.join("\n\n"));
    process.exit(2);
  }
});
