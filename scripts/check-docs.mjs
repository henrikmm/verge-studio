#!/usr/bin/env node
// Keeps the documentation honest, mechanically.
//
// The rules below exist because each one was broken once and cost something. The task list grew
// to 1,635 lines because finished work was never removed and tasks accumulated in files nobody
// treated as a backlog — so unchecked boxes are now allowed in exactly one place. Tasks that
// omitted who owns them or what it would cost got quietly skipped for weeks — so the five fields
// are required. And a document nobody can finish reading is a document nobody reads, which is why
// there are size budgets rather than good intentions.
//
// Run by scripts/verify.sh. Exits non-zero with a list of what to fix.

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

/** Directories that are not ours to police. */
const IGNORED = new Set(["node_modules", ".git", "dist", "donor", ".runs", "fixtures"]);

/**
 * Line and byte budgets.
 *
 * These are ceilings on attention, not on effort. The instruction files are read at the start of
 * every session, so they pay their cost every time; the registry is consulted, so it may be
 * longer; the task list has to stay short enough that an out-of-date entry is obvious.
 *
 * The registry's ceiling was raised 400 -> 2000 on 2026-08-06, deliberately and once. It is the
 * only document that grows with the project rather than with the current sprint: every decision
 * that holds and every measurement worth not re-deriving lands there permanently, so a cap sized
 * for the other files was forcing real evidence back out of the record. The other three are
 * unchanged and should stay that way — they are read at the start of every session.
 *
 * A wider ceiling is not an invitation. Detail that belongs in an evidence file still goes to an
 * evidence file; see section 6 of the registry for where those live.
 */
const BUDGETS = [
  { file: "AGENTS.md", lines: 180, bytes: 16 * 1024 },
  { file: "CLAUDE.md", lines: 40, bytes: 4 * 1024 },
  { file: "docs/PROGRESS.md", lines: 180, bytes: 16 * 1024 },
  // Bytes scale with the lines, or the byte cap silently becomes the real limit: the registry
  // measured 64 bytes/line on 2026-08-06, so 2000 lines is ~125 KiB. 160 KiB leaves headroom
  // for tables, which run wider than prose.
  { file: "docs/REGISTRY.md", lines: 2000, bytes: 160 * 1024 },
];

/** The one file allowed to contain unfinished work. */
const TASK_FILE = "docs/PROGRESS.md";

/** Every task must answer all five, or it is not actionable by a fresh session. */
const TASK_FIELDS = ["Outcome", "Owner", "Gate", "Evidence / starting points", "Done when"];

const GATES = ["none", "user confirmation", "cloud spend + user confirmation"];

async function markdownFiles(dir = REPO) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
    if (IGNORED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- size budgets

async function checkBudgets() {
  for (const budget of BUDGETS) {
    const path = join(REPO, budget.file);
    if (!(await exists(path))) {
      fail(budget.file, "missing — the harness expects this file to exist");
      continue;
    }
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    if (lines > budget.lines) {
      fail(budget.file, `${lines} lines, budget is ${budget.lines}. Move detail elsewhere.`);
    }
    if (bytes > budget.bytes) {
      const kib = (bytes / 1024).toFixed(1);
      fail(budget.file, `${kib} KiB, budget is ${budget.bytes / 1024} KiB.`);
    }
  }
}

// ------------------------------------------------------- unfinished work rule

async function checkTaskBoxesAreContained(files) {
  for (const path of files) {
    const rel = relative(REPO, path);
    if (rel === TASK_FILE) continue;
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/^\s*[-*]\s*\[ \]/.test(line)) {
        fail(rel, `line ${i + 1}: an unfinished task box. Tasks belong in ${TASK_FILE}.`);
      }
      // A ticked box outside the task file is finished work being kept as a trophy. The registry
      // records what works in prose; git history records when it landed.
      if (/^\s*[-*]\s*\[x\]/i.test(line)) {
        fail(rel, `line ${i + 1}: a completed task box. Record the outcome in prose instead.`);
      }
    });
  }
}

// ------------------------------------------------------------- task structure

async function checkTaskShape() {
  const path = join(REPO, TASK_FILE);
  if (!(await exists(path))) return;
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");

  // Tasks are `### ` headings. The preamble explains the fields and is not itself a task, so
  // anything above the first section heading is skipped.
  const starts = [];
  lines.forEach((line, i) => {
    if (line.startsWith("### ")) starts.push(i);
  });

  if (starts.length === 0) {
    // An empty backlog is a legitimate state and must not fail the build.
    return;
  }

  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    const title = lines[start].replace(/^###\s*/, "");
    for (const field of TASK_FIELDS) {
      if (!body.includes(`**${field}.**`) && !body.includes(`**${field}**`)) {
        fail(TASK_FILE, `task "${title}" is missing its ${field} field.`);
      }
    }
    const gate = body.match(/\*\*Gate\.\*\*\s*([^\n.]*)/);
    if (gate && !GATES.some((g) => gate[1].toLowerCase().includes(g))) {
      fail(
        TASK_FILE,
        `task "${title}" has an unrecognised gate "${gate[1].trim()}". Use one of: ${GATES.join(" | ")}.`,
      );
    }
  }
}

// ------------------------------------------------------------ the AGENTS link

async function checkClaudeBridgesToAgents() {
  const path = join(REPO, "CLAUDE.md");
  if (!(await exists(path))) return;
  const text = await readFile(path, "utf8");
  // Claude Code follows `@path` as an import. Without it the shared rules simply are not loaded,
  // and the two tools drift apart silently.
  if (!/^@AGENTS\.md\s*$/m.test(text)) {
    fail("CLAUDE.md", "must import the shared instructions with a line reading exactly `@AGENTS.md`.");
  }
}

// --------------------------------------------------------------- broken links

async function checkRelativeLinks(files) {
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const path of files) {
    const rel = relative(REPO, path);
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1].trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const withoutAnchor = target.split("#")[0];
      if (withoutAnchor === "") continue;
      const resolved = normalize(join(dirname(path), decodeURIComponent(withoutAnchor)));
      if (!(await exists(resolved))) {
        fail(rel, `link to "${target}" does not resolve.`);
      }
    }
  }
}

// ------------------------------------------------------------------ dead ends

/**
 * The approved plan used to live outside the repository, so every reference to it was a dead end
 * for anyone but its author. Nothing in the documentation may depend on a file no clone has.
 */
async function checkNoExternalPlanReferences(files) {
  for (const path of files) {
    const rel = relative(REPO, path);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/~\/\.claude\/plans\//.test(line)) {
        fail(rel, `line ${i + 1}: refers to a plan file outside the repository.`);
      }
    });
  }
}

const files = await markdownFiles();
await checkBudgets();
await checkTaskBoxesAreContained(files);
await checkTaskShape();
await checkClaudeBridgesToAgents();
await checkRelativeLinks(files);
await checkNoExternalPlanReferences(files);

if (problems.length > 0) {
  console.error("docs check FAILED\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log(`docs: OK (${files.length} markdown files)`);
