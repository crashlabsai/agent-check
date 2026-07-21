/**
 * Shared CrashLabs verdict logic: classify a system's source for the demo,
 * build the markdown report, and describe runs. Used by the GitHub check
 * driver, the CLI, and the GitHub App bot.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Kestrel tool names are dotted (payments.issue_refund); recordings use underscores. */
export const toolName = (n) => String(n).replace("_", ".");

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function truncate(text, max = 180) {
  const c = String(text).replace(/\s+/g, " ").trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/**
 * Read the system source files named by crashlabs.yml (plus a sibling
 * runtime.py if present) and return their concatenated text for classification.
 */
export function readSystemSource(configPath) {
  if (!existsSync(configPath)) return "";
  const text = readFileSync(configPath, "utf8");
  const paths = [...text.matchAll(/^\s*(?:coordinator|tools):\s*([^\s#]+)$/gm)].map((m) => m[1]);
  for (const m of text.matchAll(/^\s*-\s*(src\/[^\s#]+\.py)\s*$/gm)) paths.push(m[1]);
  const sources = [];
  for (const p of new Set(paths)) {
    if (existsSync(p)) sources.push(readFileSync(p, "utf8"));
  }
  // The runtime usually lives next to the coordinator.
  const coordinator = paths[0];
  if (coordinator) {
    const runtime = join(dirname(coordinator), "runtime.py");
    if (existsSync(runtime)) sources.push(readFileSync(runtime, "utf8"));
  }
  return sources.join("\n\n");
}

/**
 * Demo classifier — is the fraud verdict still guaranteed to precede payment
 * actions?
 *
 * Unsafe when either:
 *  - a delegation timeout exists and fraud is NOT in the required set
 *    (the timeout can drop fraud's pending verdict), or
 *  - the prompt takes a quorum shortcut with no hard fraud gate.
 */
export function classifySource(source) {
  const t = source.toLowerCase();

  const hasTimeout = /delegationpolicy\s*\([^)]*timeout_s\s*=\s*[0-9.]/s.test(t);
  const fraudRequired = /required\s*=\s*frozenset\s*\(\s*\{[^}]*["']fraud["']/s.test(t);
  if (hasTimeout && !fraudRequired) return "unsafe";

  const shortcut = /any\s+two|two\s+of\s+(the\s+)?three|2\s*of\s*3|quorum/.test(t);
  const fraudGate =
    /fraud[^.]{0,80}(mandatory|must\s+(reply|respond|return)|required|always|exempt)/.test(t) ||
    /(never|not)[^.]{0,50}before[^.]{0,30}fraud/.test(t) ||
    /wait[^.]{0,40}(for\s+)?fraud/.test(t);
  if (shortcut && !fraudGate) return "unsafe";

  return "safe";
}

/** One progress line for a normalized event, or null if it isn't worth showing. */
export function progressLine(event) {
  const p = event.payload || {};
  switch (event.type) {
    case "delegation.sent":
      return `coordinator delegates to ${p.agent}`;
    case "delegation.completed":
      return `${p.agent} reports back to coordinator`;
    case "tool.requested": {
      const tool = toolName(p.toolName);
      const money = p.toolName === "payments_issue_refund" ? "   ← money moves ($89.99)" : "";
      return `${event.agentId || "?"} calls ${tool}${money}`;
    }
    case "fault.applied":
      return `⚡ fault ${p.faultId}: delaying ${toolName(p.target)} by ${p.action?.milliseconds}ms`;
    default:
      return null;
  }
}

/** Reconstruct the world-diff impact lines from a recorded run. */
export function worldImpact(run) {
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

/** The plain-language causal narrative for the failing scenario. */
export const FAILURE_NARRATIVE =
  "This change adds a 3-second per-investigator timeout. CrashLabs delayed the fraud agent's " +
  "chargeback lookup by 4 seconds — routine dependency slowness — so the timeout fired and " +
  "fraud's pending verdict was discarded. The coordinator resolved the case without it: it " +
  "refunded the disputed payment, cancelled the customer's return, closed the ticket, and " +
  "emailed a refund confirmation. The business is now exposed to paying the same charge twice.";

export function computeResults(suite, verdict) {
  const results = suite.scenarios.map((s) => {
    const failed = verdict === "unsafe" && s.failsWhenUnsafe ? s.failsWhenUnsafe : [];
    return { id: s.id, name: s.name, checks: s.checks, durationMs: s.durationMs, failed, stream: !!s.recording };
  });
  const totalChecks = results.reduce((n, r) => n + r.checks.length, 0);
  const failedChecks = results.reduce((n, r) => n + r.failed.length, 0);
  return {
    results,
    totals: {
      totalChecks,
      failedChecks,
      passedChecks: totalChecks - failedChecks,
      // Scenarios run in parallel, so wall-clock is the slowest one.
      durationMs: Math.max(...results.map((r) => r.durationMs)),
    },
  };
}

export function buildReport({ verdict, suite, results, recording, totals, runUrl, simId }) {
  const out = [];
  const failed = verdict === "unsafe";
  const failedScenario = results.find((r) => r.failed.length > 0);

  if (failed) {
    out.push(`> ## ❌ ${totals.failedChecks} behavioral checks failed`);
    out.push(">");
    out.push(
      `> \`${failedScenario.id}\` — under a slow dependency, the support agents refund a payment that still has an open chargeback.`,
    );
  } else {
    out.push("> ## ✅ All behavioral checks passed");
    out.push(">");
    out.push("> No agent moved money it shouldn't under any scenario. Safe to merge.");
  }
  out.push("");
  out.push(
    `**${totals.totalChecks} behavioral checks across ${suite.scenarios.length} simulations** · ✅ ${totals.passedChecks} passed · ${failed ? `❌ ${totals.failedChecks} failed` : "0 failed"} · ⏱ ${fmtDuration(totals.durationMs)}`,
  );
  out.push("");

  out.push("<details open><summary><b>Simulation results</b></summary>");
  out.push("");
  out.push("| Simulation | Checks | Time | Result |");
  out.push("| :-- | :-- | :-- | :-- |");
  for (const r of results) {
    const passed = r.checks.length - r.failed.length;
    out.push(
      `| \`${r.id}\` | ${passed} / ${r.checks.length} | ${fmtDuration(r.durationMs)} | ${r.failed.length ? "❌" : "✅"} |`,
    );
  }
  out.push("");
  out.push("</details>");

  if (failedScenario && recording) {
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
    out.push(FAILURE_NARRATIVE);

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
    out.push(
      "`slow-dispute-lookup` — delayed `payments.list_disputes` by 4000ms. Deterministic: replays identically every run.",
    );
    out.push("</details>");

    const impact = worldImpact(run);
    if (impact.length) {
      out.push("");
      out.push(`<details><summary><b>🌍 World state changed (${impact.length} mutations)</b></summary>`);
      out.push("");
      out.push("```diff");
      for (const line of impact) out.push(`! ${truncate(line)}`);
      out.push("```");
      out.push("</details>");
    }

    out.push("");
    out.push(
      "> **Why the unit tests are green:** the agent's final message is a correct, professional refund confirmation. Output graders pass it. The failure is only visible in what the agents *did* — the tool calls and the resulting world state, which is what CrashLabs verifies.",
    );
    if (simId) {
      out.push("");
      out.push(`Inspect the full simulation locally: \`crashlabs sims show ${simId}\``);
    }
  }

  out.push("");
  out.push("---");
  const linkPart = runUrl ? ` · [View full run →](${runUrl})` : "";
  out.push(
    `<sub>CrashLabs · behavioral testing for AI agents${linkPart} · [docs](https://crashlabs.ai/docs)</sub>`,
  );
  return out.join("\n");
}
