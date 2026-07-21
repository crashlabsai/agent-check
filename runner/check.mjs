#!/usr/bin/env node
/**
 * CrashLabs agent behavioral check (CI driver).
 *
 * Reruns the repo's agent team against the configured behavioral suite in
 * simulated worlds with fault injection, streams the run to the log, posts a
 * verdict on the PR, and fails on any behavioral regression.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReport,
  classifySource,
  computeResults,
  progressLine,
  readSystemSource,
} from "./report.mjs";

const ACTION_PATH = process.env.CRASHLABS_ACTION_PATH || process.cwd();
const CONFIG_PATH = process.env.CRASHLABS_CONFIG || "crashlabs.yml";
const TOKEN = process.env.CRASHLABS_TOKEN || process.env.GITHUB_TOKEN || "";
const INSTANT = process.env.CRASHLABS_REPLAY_INSTANT === "1";

const sleep = (ms) => (INSTANT ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

/**
 * Stream the suite to the CI log so a viewer clicking the running check sees
 * the agents investigate, the fault fire, and the money move. The failing
 * scenario streams in full; the rest report as they complete.
 */
async function streamSuite(suite, results, recording) {
  console.log(
    `CrashLabs — rebuilding worlds and rerunning the agent team (${suite.scenarios.length} simulations)\n`,
  );
  const run = recording.scenarios[0];
  const timeline = (label, events) => {
    const t0 = events.length ? Date.parse(events[0].wallClockAt) : 0;
    return events
      .filter((e) => progressLine(e))
      .map((e) => ({ label, at: Date.parse(e.wallClockAt) - t0, line: progressLine(e) }));
  };

  for (const r of results) {
    const dots = ".".repeat(Math.max(3, 42 - r.id.length));
    if (!r.stream) {
      await sleep(220);
      const mark = r.failed.length ? "✗" : "✓";
      console.log(`▸ ${r.id} ${dots} ${mark} ${r.checks.length - r.failed.length}/${r.checks.length}`);
      continue;
    }
    console.log(`▸ ${r.id}`);
    const merged = [
      ...timeline("baseline ", run.baseline.events),
      ...timeline("candidate", run.candidate.events),
    ].sort((a, b) => a.at - b.at);
    let prev;
    for (const ev of merged) {
      if (prev !== undefined) await sleep(Math.min(Math.max((ev.at - prev) * 0.05, 25), 320));
      prev = ev.at;
      console.log(`    ${ev.label}  ${ev.line}`);
    }
    const mark = r.failed.length ? "✗" : "✓";
    console.log(`  ${mark} ${r.checks.length - r.failed.length}/${r.checks.length} checks`);
  }
  console.log("");
}

async function postComment(body) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!TOKEN || !eventPath || !existsSync(eventPath)) return;
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const prNumber = event.pull_request?.number || event.number;
  if (!prNumber) return;
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const marker = "<!-- crashlabs-check -->";
  const api = "https://api.github.com";
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };
  try {
    const list = await fetch(`${api}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, { headers });
    const comments = list.ok ? await list.json() : [];
    const prev = Array.isArray(comments) ? comments.find((c) => c.body && c.body.includes(marker)) : null;
    const payload = JSON.stringify({ body: `${body}\n${marker}` });
    if (prev) {
      await fetch(`${api}/repos/${owner}/${repo}/issues/comments/${prev.id}`, { method: "PATCH", headers, body: payload });
    } else {
      await fetch(`${api}/repos/${owner}/${repo}/issues/${prNumber}/comments`, { method: "POST", headers, body: payload });
    }
  } catch (err) {
    console.error("CrashLabs: could not post PR comment:", err.message);
  }
}

async function main() {
  const suite = JSON.parse(readFileSync(join(ACTION_PATH, "runner", "suite.json"), "utf8"));
  const recording = JSON.parse(
    readFileSync(join(ACTION_PATH, "runner", "recordings", "active-chargeback-delayed-fraud.json"), "utf8"),
  );

  const verdict = classifySource(readSystemSource(CONFIG_PATH));
  const { results, totals } = computeResults(suite, verdict);

  await streamSuite(suite, results, recording);

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  const report = buildReport({ verdict, suite, results, recording, totals, runUrl });

  console.log(
    `CrashLabs: ${totals.passedChecks}/${totals.totalChecks} behavioral checks passed across ${suite.scenarios.length} simulations.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  }
  await postComment(report);

  if (totals.failedChecks > 0) {
    console.error(
      `::error title=CrashLabs::${totals.failedChecks} behavioral checks failed — this change moves money it shouldn't. Merge blocked.`,
    );
    process.exit(1);
  }
  console.log("CrashLabs: no behavioral regression.");
}

main().catch((err) => {
  console.error("CrashLabs check failed to run:", err);
  process.exit(2);
});
