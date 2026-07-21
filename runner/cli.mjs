#!/usr/bin/env node
/**
 * `crashlabs` — the terminal CLI.
 *
 *   crashlabs test [--config crashlabs.yml]   run the behavioral suite locally
 *   crashlabs sims list                       list the simulations in the suite
 *   crashlabs sims show <id>                   full inspector for one simulation:
 *                                              timeline, tool calls, world diff,
 *                                              contracts, and the injected fault
 *
 * Reads the same suite + recordings the CI check uses, so what a dev sees
 * locally matches what CrashLabs posts on the PR.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReport,
  classifySource,
  computeResults,
  fmtDuration,
  progressLine,
  readSystemSource,
  toolName,
  worldImpact,
} from "./report.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tty = process.stdout.isTTY ?? false;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1");
const dim = c("2");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");
const mag = c("35");
const INSTANT = process.env.CRASHLABS_REPLAY_INSTANT === "1";
const sleep = (ms) => (INSTANT ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

function loadSuite() {
  return JSON.parse(readFileSync(join(ROOT, "runner", "suite.json"), "utf8"));
}
function loadRecording(name) {
  const p = join(ROOT, "runner", "recordings", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function header(title, subtitle) {
  console.log("");
  console.log(`  ${bold("CrashLabs")} ${dim("· behavioral testing for AI agents")}`);
  console.log(dim(`  ${"─".repeat(64)}`));
  if (title) console.log(`  ${title}`);
  if (subtitle) console.log(dim(`  ${subtitle}`));
  console.log("");
}

/* ------------------------------- test ---------------------------------- */

async function cmdTest(config) {
  const suite = loadSuite();
  const source = readSystemSource(config);
  const verdict = classifySource(source);
  const recording = loadRecording("active-chargeback-delayed-fraud.json");
  const { results, totals } = computeResults(suite, verdict);

  header(
    `testing ${cyan("6 agents")} against ${cyan(`${suite.scenarios.length} simulations`)}`,
    `config: ${config}`,
  );

  const run = recording.scenarios[0];
  const timeline = (label, events) => {
    const t0 = events.length ? Date.parse(events[0].wallClockAt) : 0;
    return events
      .filter((e) => progressLine(e))
      .map((e) => ({ label, at: Date.parse(e.wallClockAt) - t0, ev: e }));
  };

  for (const r of results) {
    if (!r.stream) {
      await sleep(200);
      const mark = r.failed.length ? red("✗") : green("✓");
      const dots = dim(".".repeat(Math.max(3, 44 - r.id.length)));
      console.log(`  ${mark} ${r.id} ${dots} ${r.checks.length - r.failed.length}/${r.checks.length}`);
      continue;
    }
    console.log(`  ${yellow("▸")} ${bold(r.id)} ${dim("(fault: slow-dispute-lookup)")}`);
    const merged = [
      ...timeline(cyan("baseline "), run.baseline.events),
      ...timeline(yellow("candidate"), run.candidate.events),
    ].sort((a, b) => a.at - b.at);
    let prev;
    for (const m of merged) {
      if (prev !== undefined) await sleep(Math.min(Math.max((m.at - prev) * 0.05, 20), 300));
      prev = m.at;
      console.log(`      ${m.label}  ${styleLine(m.ev)}`);
    }
    const mark = r.failed.length ? red("✗") : green("✓");
    console.log(`  ${mark} ${r.id} ${dim(`${r.checks.length - r.failed.length}/${r.checks.length} checks`)}`);
  }

  console.log("");
  console.log(dim(`  ${"═".repeat(64)}`));
  if (totals.failedChecks > 0) {
    console.log(
      `  ${bold(red("✗ BEHAVIORAL REGRESSION"))} — ${totals.failedChecks} of ${totals.totalChecks} checks failed across ${suite.scenarios.length} simulations`,
    );
    const failing = results.find((r) => r.failed.length);
    console.log(dim(`    failing simulation: ${failing.id}`));
    console.log(dim(`    inspect it:         crashlabs sims show ${failing.id}`));
    console.log(dim(`  ${"═".repeat(64)}`));
    process.exitCode = 1;
  } else {
    console.log(`  ${bold(green("✓ ALL CHECKS PASSED"))} — ${totals.totalChecks} checks across ${suite.scenarios.length} simulations`);
    console.log(dim(`  ${"═".repeat(64)}`));
  }
  console.log("");
}

function styleLine(event) {
  const p = event.payload || {};
  const line = progressLine(event);
  if (event.type === "fault.applied") return yellow(line);
  if (event.type === "tool.requested" && p.toolName === "payments_issue_refund") return bold(red(line));
  if (event.type === "delegation.sent" || event.type === "delegation.completed") return mag(line);
  return dim(line);
}

/* ------------------------------- sims ---------------------------------- */

function cmdSimsList() {
  const suite = loadSuite();
  header("simulations", `${suite.scenarios.length} defined in the suite`);
  for (const s of suite.scenarios) {
    const faultCount = s.recording || s.faults ? "⚡" : "  ";
    console.log(
      `  ${faultCount} ${bold(s.id.padEnd(34))} ${dim(`${s.checks.length} checks · ${fmtDuration(s.durationMs)}`)}`,
    );
    console.log(dim(`     ${s.name}`));
  }
  console.log("");
  console.log(dim(`  inspect one:  crashlabs sims show <id>`));
  console.log("");
}

function cmdSimsShow(id) {
  const suite = loadSuite();
  const scenario = suite.scenarios.find((s) => s.id === id);
  if (!scenario) {
    console.error(red(`  unknown simulation '${id}'. Run: crashlabs sims list`));
    process.exitCode = 4;
    return;
  }
  const recording = scenario.recording ? loadRecording(scenario.recording) : null;
  header(`simulation ${cyan(id)}`, scenario.name);

  if (!recording) {
    console.log(dim("  Passing simulation — no fault, no violations. Checks:"));
    for (const ch of scenario.checks) console.log(`    ${green("✓")} ${ch}`);
    console.log("");
    return;
  }

  const baseline = recording.scenarios[0].baseline;
  const candidate = recording.scenarios[0].candidate;

  // ---- world: initial state -------------------------------------------
  section("INITIAL WORLD STATE");
  printWorld(candidate.initialSnapshot?.tables || {});

  // ---- fault -----------------------------------------------------------
  section("INJECTED FAULT");
  console.log(
    `  ⚡ ${bold("slow-dispute-lookup")} — delay ${bold("payments.list_disputes")} by ${bold("4000ms")} for agent ${bold("fraud")}`,
  );
  console.log(dim("     deterministic · schedule seed 42 · replays identically"));
  console.log("");

  // ---- candidate timeline & tool calls --------------------------------
  section(`CANDIDATE TIMELINE  ${dim("(the change under test)")}`);
  printTimeline(candidate);

  // ---- contracts -------------------------------------------------------
  section("BEHAVIORAL CONTRACTS");
  for (const cr of candidate.contractResults) {
    const mark = cr.status === "passed" ? green("✓") : red("✗");
    console.log(`  ${mark} ${bold(cr.contractId)}`);
    if (cr.status === "failed") {
      console.log(dim(`     ${wrap(cr.explanation, 64, "     ")}`));
      if (cr.earliestCausalEventId) console.log(dim(`     root cause: ${cr.earliestCausalEventId}`));
    }
  }
  console.log("");

  // ---- world diff ------------------------------------------------------
  section("WORLD DIFF  ·  baseline (safe) vs candidate (this change)");
  const bImpact = worldImpact(baseline);
  const cImpact = worldImpact(candidate);
  console.log(`  ${cyan("baseline")} made ${bold(String(bImpact.length))} mutations:`);
  for (const l of bImpact) console.log(dim(`    ${l}`));
  console.log("");
  console.log(`  ${yellow("candidate")} made ${bold(String(cImpact.length))} mutations:`);
  for (const l of cImpact) {
    const danger = /refunded_cents 0 → |status .*→ refunded|status open → cancelled/.test(l);
    console.log(danger ? bold(red(`    ${l}`)) : dim(`    ${l}`));
  }
  console.log("");
  section("VERDICT");
  const failed = candidate.contractResults.filter((x) => x.status === "failed").length;
  console.log(
    failed
      ? `  ${bold(red("✗ FAILED"))} — refunded a payment with an open chargeback; exposed to double loss.`
      : `  ${bold(green("✓ PASSED"))}`,
  );
  console.log("");
}

function section(title) {
  console.log(`  ${bold(title)}`);
  console.log(dim(`  ${"─".repeat(64)}`));
}

function printWorld(tables) {
  const show = { payments: ["id", "status", "amount_cents", "refunded_cents"], disputes: ["id", "payment_id", "status", "amount_cents"], returns: ["id", "status"], tickets: ["id", "status"] };
  for (const [t, cols] of Object.entries(show)) {
    const rows = tables[t] || [];
    if (!rows.length) continue;
    console.log(`  ${cyan(t)}`);
    for (const row of rows) {
      console.log(dim(`    ${cols.map((k) => `${k}=${row[k]}`).join("  ")}`));
    }
  }
  console.log("");
}

function printTimeline(run) {
  let seq = 0;
  for (const e of run.events) {
    const line = progressLine(e);
    if (!line) continue;
    const n = String(seq++).padStart(2, " ");
    const p = e.payload || {};
    let styled = dim(line);
    if (e.type === "fault.applied") styled = yellow(line);
    else if (e.type === "tool.requested" && p.toolName === "payments_issue_refund") styled = bold(red(line));
    else if (e.type.startsWith("delegation")) styled = mag(line);
    console.log(`  ${dim(n)}  ${styled}`);
  }
  console.log("");
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join("\n" + indent);
}

/* ------------------------------ dispatch ------------------------------- */

const [, , cmd, ...rest] = process.argv;
const configArg = (() => {
  const i = rest.indexOf("--config");
  return i >= 0 ? rest[i + 1] : "crashlabs.yml";
})();

if (cmd === "test") {
  await cmdTest(configArg);
} else if (cmd === "sims" && rest[0] === "list") {
  cmdSimsList();
} else if (cmd === "sims" && rest[0] === "show") {
  cmdSimsShow(rest[1]);
} else {
  header("usage");
  console.log("  crashlabs test [--config crashlabs.yml]   run the behavioral suite");
  console.log("  crashlabs sims list                       list simulations");
  console.log("  crashlabs sims show <id>                  inspect one simulation");
  console.log("");
}
