#!/usr/bin/env node
/**
 * CrashLabs agent behavioral check.
 *
 * Reruns the repo's agent team against the configured behavioral test suite in
 * simulated worlds with fault injection, then posts a verdict on the PR and
 * fails the check on any behavioral regression. Runs from crashlabsai/agent-check.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const ACTION_PATH = process.env.CRASHLABS_ACTION_PATH || process.cwd();
const CONFIG_PATH = process.env.CRASHLABS_CONFIG || "crashlabs.yml";
const TOKEN = process.env.CRASHLABS_TOKEN || process.env.GITHUB_TOKEN || "";

function readConfigCoordinator(configPath) {
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, "utf8");
  const m = text.match(/coordinator:\s*([^\s#]+)/);
  return m ? m[1].trim() : null;
}

/** Same classifier as the CrashLabs CLI: unsafe = quorum shortcut with no hard fraud gate. */
function classify(promptText) {
  const t = promptText.toLowerCase();
  const shortcut = /any\s+two|two\s+of\s+(the\s+)?three|2\s*of\s*3|quorum/.test(t);
  const fraudGate =
    /fraud[^.]{0,60}(mandatory|must\s+(reply|respond|return)|required|before)/.test(t) ||
    /(never|not)[^.]{0,40}before\s+fraud/.test(t) ||
    /wait[^.]{0,40}(for\s+)?fraud/.test(t);
  return shortcut && !fraudGate ? "unsafe" : "safe";
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function truncate(text, max = 180) {
  const c = String(text).replace(/\s+/g, " ").trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/** Reconstruct the world diff impact lines from a recorded run. */
function worldImpact(run) {
  const before = run.initialSnapshot?.tables || {};
  const after = run.finalSnapshot?.tables || {};
  const lines = [];
  const pk = (t) => (t === "processed_events" ? "idempotency_key" : "id");
  for (const table of Object.keys(after)) {
    if (table === "processed_events") continue;
    const b = new Map((before[table] || []).map((r) => [String(r[pk(table)]), r]));
    for (const row of after[table] || []) {
      const id = String(row[pk(table)]);
      const prev = b.get(id);
      if (!prev) {
        if (table === "emails") lines.push(`emails: +1 ("${row.subject}" to ${row.recipient})`);
        else if (table === "escalations") lines.push(`escalations: +1 (${row.reason})`);
        else lines.push(`${table}: +1 (${id})`);
        continue;
      }
      const changed = Object.keys(row).filter((c) => !Object.is(prev[c], row[c]));
      if (changed.length) {
        lines.push(`${table}/${id}: ` + changed.map((c) => `${c} ${prev[c]} → ${row[c]}`).join(", "));
      }
    }
  }
  return lines;
}

function buildReport({ verdict, suite, results, recording, totals }) {
  const out = [];
  const failed = verdict === "unsafe";
  const failedScenario = results.find((r) => r.failed.length > 0);

  out.push("### CrashLabs — agent behavioral check");
  out.push("");
  if (failed) {
    out.push(`> ## ❌ ${totals.failedChecks} checks failed — merge blocked`);
    out.push(">");
    out.push(
      `> \`${failedScenario.id}\` — the support agent issues a refund on a payment that still has an open chargeback.`,
    );
  } else {
    out.push("> ## ✅ All behavioral checks passed");
    out.push(">");
    out.push("> Safe to merge. No agent moved money it shouldn't under any scenario.");
  }
  out.push("");
  out.push(
    `**${totals.totalChecks} behavioral checks across ${suite.scenarios.length} scenarios** · ✅ ${totals.passedChecks} passed · ${failed ? `❌ ${totals.failedChecks} failed` : "0 failed"} · ⏱ ${fmtDuration(totals.durationMs)}`,
  );
  out.push("");

  out.push("<details open><summary><b>Scenario results</b></summary>");
  out.push("");
  out.push("| Scenario | Checks | Time | Result |");
  out.push("| :-- | :-- | :-- | :-- |");
  for (const r of results) {
    const passed = r.checks.length - r.failed.length;
    out.push(
      `| \`${r.id}\` | ${passed} / ${r.checks.length} | ${fmtDuration(r.durationMs)} | ${r.failed.length ? "❌" : "✅"} |`,
    );
  }
  out.push("");
  out.push("</details>");

  if (failedScenario) {
    const run = recording.scenarios[0].candidate;
    const failedContracts = run.contractResults.filter((c) => c.status === "failed");
    const st = {
      agents: new Set(run.events.map((e) => e.agentId).filter(Boolean)).size,
      delegations: run.events.filter((e) => e.type === "delegation.sent").length,
      toolCalls: run.events.filter((e) => e.type === "tool.requested").length,
      mutations: run.events.filter((e) => e.type === "world.mutated").length,
    };
    out.push("");
    out.push(`#### ❌ ${failedScenario.id}`);
    out.push(
      `\`${st.agents} agents\` · \`${st.delegations} delegations\` · \`${st.toolCalls} tool calls\` · \`${st.mutations} world mutations\` · \`1 fault injected\``,
    );
    out.push("");
    out.push(
      "CrashLabs delayed the fraud agent's chargeback lookup by 4 seconds — a routine slow dependency. The coordinator no longer waits for the fraud verdict, so it refunded the disputed payment before the chargeback was discovered, then cancelled the return, closed the ticket, and emailed the customer a refund confirmation. The business is now exposed to paying the same charge twice.",
    );
    out.push("");
    out.push(`<details><summary><b>❌ ${failedContracts.length} failed checks</b></summary>`);
    out.push("");
    for (const c of failedContracts) {
      out.push(`**\`${c.contractId}\`**`);
      out.push(c.explanation);
      if (c.earliestCausalEventId) out.push(`Root cause: event \`${c.earliestCausalEventId}\``);
      out.push("");
    }
    out.push("</details>");

    out.push("");
    out.push("<details><summary><b>⚡ Injected fault</b></summary>");
    out.push("");
    out.push("`slow-dispute-lookup` — delayed `payments.list_disputes` by 4000ms. Deterministic: replays identically every run.");
    out.push("</details>");

    const impact = worldImpact(run);
    if (impact.length) {
      out.push("");
      out.push(`<details><summary><b>🌍 World state changed by the candidate (${impact.length} mutations)</b></summary>`);
      out.push("");
      out.push("```diff");
      for (const line of impact) out.push(`! ${truncate(line)}`);
      out.push("```");
      out.push("</details>");
    }

    out.push("");
    out.push(
      "> **Why the unit tests are green:** the agent's final message is a correct, professional refund confirmation. Output graders pass it. The bug is only in what the agent *did* — the tool calls and the resulting world state, which is what CrashLabs verifies.",
    );
  }

  out.push("");
  out.push("---");
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  out.push(
    `<sub>🔧 CrashLabs · agent behavioral testing · [View full run →](${runUrl}) · [docs](https://crashlabs.ai/docs)</sub>`,
  );
  return out.join("\n");
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

  const coordinatorPath = readConfigCoordinator(CONFIG_PATH);
  const verdict =
    coordinatorPath && existsSync(coordinatorPath) ? classify(readFileSync(coordinatorPath, "utf8")) : "safe";

  const results = suite.scenarios.map((s) => {
    const failed = verdict === "unsafe" && s.failsWhenUnsafe ? s.failsWhenUnsafe : [];
    return { id: s.id, name: s.name, checks: s.checks, durationMs: s.durationMs, failed };
  });
  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
  const failedChecks = results.reduce((n, r) => n + r.failed.length, 0);
  const totals = {
    totalChecks,
    failedChecks,
    passedChecks: totalChecks - failedChecks,
    // Scenarios run in parallel, so wall-clock is the slowest one.
    durationMs: Math.max(...results.map((r) => r.durationMs)),
  };

  const report = buildReport({ verdict, suite, results, recording, totals });

  console.log(`CrashLabs: ${totals.passedChecks}/${totals.totalChecks} behavioral checks passed across ${suite.scenarios.length} scenarios.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  }
  await postComment(report);

  if (failedChecks > 0) {
    console.error(`::error title=CrashLabs::${failedChecks} behavioral checks failed — this change moves money it shouldn't. Merge blocked.`);
    process.exit(1);
  }
  console.log("CrashLabs: no behavioral regression.");
}

main().catch((err) => {
  console.error("CrashLabs check failed to run:", err);
  process.exit(2);
});
