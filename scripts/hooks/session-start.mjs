#!/usr/bin/env node
// SessionStart hook: show git status + the active spec so every new agent
// context knows what's in scope.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = process.cwd();

let status = "";
try {
  status = execSync("git status --short", { cwd: repo, encoding: "utf8", timeout: 5000 });
} catch {
  // not a git repo, or git not installed; quietly skip
}

let currentSpec = "(none — run the planner agent)";
try {
  currentSpec = readFileSync(resolve(repo, ".claude/CURRENT_SPEC"), "utf8").trim();
} catch {
  // not set
}

const lines = ["# Session context", "", `**Active spec**: ${currentSpec || "(empty)"}`];
if (status.trim()) {
  lines.push("", "**Uncommitted changes:**", "```", status.trim(), "```");
} else {
  lines.push("", "Working tree is clean.");
}

console.log(lines.join("\n"));
