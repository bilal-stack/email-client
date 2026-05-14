#!/usr/bin/env node
// Stop hook: surface a lint + test summary at the end of every agent turn,
// so we never ship a session that broke a previously-green project.
import { execSync } from "node:child_process";

function runSummary(label, cmd) {
  try {
    execSync(cmd, { stdio: "pipe", timeout: 120_000, encoding: "utf8" });
    return `✓ ${label}`;
  } catch (err) {
    const tail = (err?.stdout ?? err?.stderr ?? "").toString().split("\n").slice(-15).join("\n");
    return `✗ ${label}\n${tail}`;
  }
}

const out = [runSummary("lint", "npm run -s lint"), runSummary("tests", "npm run -s test:run")];
console.log(out.join("\n\n"));
